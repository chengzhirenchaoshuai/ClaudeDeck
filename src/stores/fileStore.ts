import { create } from 'zustand';
import { bridge, FileNode, RecentProject, isRemotePath } from '../lib/tauri-bridge';
import { isHomeDirectory } from '../lib/home-dir';

export type FileChangeKind = 'created' | 'modified' | 'removed';
export type PreviewMode = 'preview' | 'source' | 'edit';

// Batch buffer for markFileChanged — collect changes within a single frame, flush once via rAF
const _pendingChanges = new Map<string, FileChangeKind>();
let _changeFlushRaf = 0;

interface FileState {
  tree: FileNode[];
  isLoading: boolean;
  selectedFile: string | null;
  fileContent: string | null;
  isLoadingContent: boolean;
  previewMode: PreviewMode;
  rootPath: string;

  // Editing state
  editContent: string | null;     // buffer for edits (null = not dirty)
  isSaving: boolean;

  // Unsaved changes navigation guard
  pendingNavigation: string | null;
  showUnsavedDialog: boolean;

  // Project management
  recentProjects: RecentProject[];
  isLoadingProjects: boolean;

  // File change tracking
  changedFiles: Map<string, FileChangeKind>;

  // Directory missing detection
  directoryMissing: boolean;

  // External drag-drop state
  isDragOverTree: boolean;

  /** 文件树中已展开的目录（node.path），切换项目时清空 */
  expandedDirs: Set<string>;
  /** 待定位的节点路径：对应节点渲染后滚动到可见处并短暂高亮，随后清空 */
  revealTarget: string | null;

  loadTree: (path: string) => Promise<void>;
  /** 目录被判定为缺失时复查：确实存在就重新加载并清除“缺失”标记 */
  recheckDirectory: (path: string) => Promise<void>;
  /** Refresh the tree without clearing change markers. Optional path overrides rootPath. */
  refreshTree: (overridePath?: string) => Promise<void>;
  selectFile: (path: string) => Promise<void>;
  clearSelection: () => void;
  closePreview: () => void;
  setPreviewMode: (mode: PreviewMode) => void;
  setEditContent: (content: string) => void;
  saveFile: () => Promise<void>;
  discardEdits: () => void;
  setRootPath: (path: string) => void;
  fetchRecentProjects: () => Promise<void>;
  /** Reload the currently previewed file content without toggling selection */
  reloadContent: () => Promise<void>;
  markFileChanged: (path: string, kind: FileChangeKind) => void;
  clearChangedFiles: () => void;
  // Unsaved changes actions
  confirmDiscard: () => void;
  confirmSaveAndSwitch: () => Promise<void>;
  cancelNavigation: () => void;
  // New file/folder actions
  createFile: (parentDir: string, name: string) => Promise<void>;
  createFolder: (parentDir: string, name: string) => Promise<void>;
  // External drag state
  setDragOverTree: (v: boolean) => void;
  /** 展开 / 收起文件树中的目录 */
  toggleDir: (path: string) => void;
  /** 在文件树中定位：展开各级父目录并标记待滚动的节点。树里找不到时返回 false */
  revealInTree: (path: string) => boolean;
  clearRevealTarget: () => void;
}

/** 路径比较用的规范形式：统一正斜杠、去掉末尾斜杠、忽略大小写（只支持 Windows，本机与远端都不区分大小写） */
function normalizeTreePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 在树中查找目标节点，返回从根到目标的节点路径链（含目标本身）；找不到返回 null */
function findNodeChain(nodes: FileNode[], target: string): string[] | null {
  for (const node of nodes) {
    const key = normalizeTreePath(node.path);
    if (key === target) return [node.path];
    // 只进入目标所在的目录分支，避免遍历整棵树
    if (node.is_dir && node.children && target.startsWith(key + '/')) {
      const chain = findNodeChain(node.children, target);
      if (chain) return [node.path, ...chain];
    }
  }
  return null;
}

/** 再用 read_dir 确认一次目录是否真的不存在，避免一次瞬时失败就把目录判定为缺失 */
async function confirmMissing(path: string): Promise<boolean> {
  // 远程目录是否存在由后端经 ssh 判定（read_file_tree 返回 "Directory does not exist"），
  // 本机的 read_dir 对 ssh:// 路径没有意义，不能再复查
  if (isRemotePath(path)) return true;
  try {
    await bridge.checkFileAccess(path); // 存在但无权限时返回 false，也算存在
    return false;
  } catch {
    return true;
  }
}

export const useFileStore = create<FileState>()((set, get) => ({
  tree: [],
  isLoading: false,
  selectedFile: null,
  fileContent: null,
  isLoadingContent: false,
  previewMode: 'preview' as PreviewMode,
  rootPath: '',
  editContent: null,
  isSaving: false,
  pendingNavigation: null,
  showUnsavedDialog: false,
  recentProjects: [],
  isLoadingProjects: false,
  changedFiles: new Map(),
  directoryMissing: false,
  isDragOverTree: false,
  expandedDirs: new Set(),
  revealTarget: null,

  loadTree: async (path: string) => {
    if (!path) return;
    const prevRoot = get().rootPath;
    const isNewDir = path !== prevRoot;
    // Always show loading on first load or directory change
    set({
      rootPath: path,
      isLoading: true,
      // Clear stale tree immediately when switching directories
      ...(isNewDir ? { tree: [], expandedDirs: new Set<string>(), revealTarget: null } : {}),
    });
    // 主目录不加载文件树（原因见 lib/home-dir.ts），只清掉上一个项目留下的树
    if (await isHomeDirectory(path)) {
      if (get().rootPath === path) {
        set({ tree: [], isLoading: false, changedFiles: new Map(), directoryMissing: false });
      }
      return;
    }
    try {
      const tree = await bridge.readFileTree(path, 8);
      // Guard: only apply if rootPath hasn't changed during async load
      if (get().rootPath === path) {
        set({ tree, isLoading: false, changedFiles: new Map(), directoryMissing: false });
      }
    } catch (err) {
      if (get().rootPath === path) {
        const missing = String(err).includes('does not exist') && (await confirmMissing(path));
        if (get().rootPath === path) set({ isLoading: false, directoryMissing: missing });
      }
    }
  },

  recheckDirectory: async (path: string) => {
    if (!path || (await confirmMissing(path))) return;
    await get().loadTree(path);
    if (get().rootPath === path) set({ directoryMissing: false });
  },

  refreshTree: async (overridePath?: string) => {
    const dir = overridePath || get().rootPath;
    if (!dir) return;
    // 工具执行完、文件变化、手动刷新都会走到这里，主目录一律不扫描
    if (await isHomeDirectory(dir)) {
      if (overridePath && overridePath !== get().rootPath) set({ tree: [], rootPath: overridePath });
      return;
    }
    try {
      const tree = await bridge.readFileTree(dir, 8);
      // Sync rootPath if override was used and differs
      if (overridePath && overridePath !== get().rootPath) {
        set({ tree, rootPath: overridePath });
      } else {
        set({ tree });
      }
    } catch (err) {
      if (String(err).includes('does not exist') && (await confirmMissing(dir)) && get().rootPath === dir) {
        set({ directoryMissing: true, tree: [] });
      }
    }
  },

  selectFile: async (path: string) => {
    const { selectedFile, editContent, fileContent } = get();
    const isDirty = editContent !== null && editContent !== fileContent;

    // If dirty and trying to navigate to a different file, show dialog
    if (isDirty && path !== selectedFile) {
      set({ pendingNavigation: path, showUnsavedDialog: true });
      return;
    }

    // Toggle selection: click again to deselect
    if (selectedFile === path) {
      set({ selectedFile: null, fileContent: null, isLoadingContent: false, editContent: null });
    } else {
      set({ selectedFile: path, fileContent: null, isLoadingContent: true, previewMode: 'preview', editContent: null });

      // Binary-preview files: skip text reading, render with file:// URL in FilePreview
      const ext = path.split('.').pop()?.toLowerCase() || '';
      const BINARY_PREVIEW = new Set([
        'png','jpg','jpeg','gif','webp','bmp','ico',
        'pdf','mp4','webm','mov','avi',
        'mp3','wav','ogg','aac','m4a',
      ]);

      if (BINARY_PREVIEW.has(ext)) {
        // Load binary files as base64 data URL for rendering in webview
        try {
          const dataUrl = await bridge.readFileBase64(path);
          if (get().selectedFile === path) {
            set({ fileContent: dataUrl, isLoadingContent: false });
          }
        } catch {
          if (get().selectedFile === path) {
            set({ fileContent: null, isLoadingContent: false });
          }
        }
      } else {
        try {
          const content = await bridge.readFileContent(path);
          // Only update if selectedFile hasn't changed during the async call
          if (get().selectedFile === path) {
            set({ fileContent: content, isLoadingContent: false });
          }
        } catch (err) {
          if (get().selectedFile === path) {
            set({ fileContent: `// Error loading file: ${err}`, isLoadingContent: false });
          }
        }
      }
    }
  },

  clearSelection: () => set({ selectedFile: null, fileContent: null, isLoadingContent: false, editContent: null }),

  closePreview: () => set({ selectedFile: null, fileContent: null, isLoadingContent: false, editContent: null }),

  setPreviewMode: (mode: PreviewMode) => {
    const state = get();
    if (mode === 'edit') {
      // Entering edit mode: initialize editContent from fileContent
      set({ previewMode: mode, editContent: state.fileContent });
    } else {
      set({ previewMode: mode });
    }
  },

  setEditContent: (content: string) => set({ editContent: content }),

  saveFile: async () => {
    const { selectedFile, editContent } = get();
    if (!selectedFile || editContent === null) return;
    set({ isSaving: true });
    try {
      await bridge.writeFileContent(selectedFile, editContent);
      // Update fileContent to match saved content
      set({ fileContent: editContent, editContent: null, isSaving: false, previewMode: 'preview' });
    } catch {
      set({ isSaving: false });
    }
  },

  discardEdits: () => {
    set({ editContent: null, previewMode: 'preview' });
  },

  setRootPath: (path: string) => set({ rootPath: path }),

  fetchRecentProjects: async () => {
    set({ isLoadingProjects: true });
    try {
      const projects = await bridge.listRecentProjects();
      set({ recentProjects: projects, isLoadingProjects: false });
    } catch {
      set({ isLoadingProjects: false });
    }
  },

  reloadContent: async () => {
    const path = get().selectedFile;
    if (!path) return;
    // Don't reload while user is editing
    if (get().editContent !== null) return;
    try {
      const ext = path.split('.').pop()?.toLowerCase() || '';
      const BINARY_PREVIEW = new Set([
        'png','jpg','jpeg','gif','webp','bmp','ico',
        'pdf','mp4','webm','mov','avi',
        'mp3','wav','ogg','aac','m4a',
      ]);
      if (BINARY_PREVIEW.has(ext)) {
        const dataUrl = await bridge.readFileBase64(path);
        if (get().selectedFile === path) set({ fileContent: dataUrl });
      } else {
        const content = await bridge.readFileContent(path);
        if (get().selectedFile === path) set({ fileContent: content });
      }
    } catch {
      // Silently fail — keep existing content
    }
  },

  markFileChanged: (path: string, kind: FileChangeKind) => {
    _pendingChanges.set(path, kind);
    if (!_changeFlushRaf) {
      _changeFlushRaf = requestAnimationFrame(() => {
        _changeFlushRaf = 0;
        if (_pendingChanges.size === 0) return;
        const next = new Map(get().changedFiles);
        for (const [p, k] of _pendingChanges) {
          next.set(p, k);
        }
        _pendingChanges.clear();
        set({ changedFiles: next });
      });
    }
  },

  clearChangedFiles: () => set({ changedFiles: new Map() }),

  // --- Unsaved changes dialog actions ---

  confirmDiscard: () => {
    const pending = get().pendingNavigation;
    set({ editContent: null, showUnsavedDialog: false, pendingNavigation: null });
    if (pending) get().selectFile(pending);
  },

  confirmSaveAndSwitch: async () => {
    const pending = get().pendingNavigation;
    await get().saveFile();
    set({ showUnsavedDialog: false, pendingNavigation: null });
    if (pending) get().selectFile(pending);
  },

  cancelNavigation: () => {
    set({ pendingNavigation: null, showUnsavedDialog: false });
  },

  // --- New file/folder actions ---

  createFile: async (parentDir: string, name: string) => {
    const path = `${parentDir}/${name}`;
    try {
      await bridge.writeFileContent(path, '');
      await get().refreshTree();
      get().selectFile(path);
    } catch {
      // Silently fail
    }
  },

  createFolder: async (parentDir: string, name: string) => {
    const path = `${parentDir}/${name}`;
    try {
      await bridge.createDirectory(path);
      await get().refreshTree();
    } catch {
      // Silently fail
    }
  },

  // --- External drag state ---

  setDragOverTree: (v: boolean) => set({ isDragOverTree: v }),

  // --- 文件树展开与定位 ---

  toggleDir: (path: string) => {
    const next = new Set(get().expandedDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    set({ expandedDirs: next });
  },

  revealInTree: (path: string) => {
    const chain = findNodeChain(get().tree, normalizeTreePath(path));
    if (!chain) return false;
    const target = chain[chain.length - 1];
    const next = new Set(get().expandedDirs);
    // 只展开父目录；目标本身是目录时保持原样
    for (const dir of chain.slice(0, -1)) next.add(dir);
    set({ expandedDirs: next, revealTarget: target });
    return true;
  },

  clearRevealTarget: () => set({ revealTarget: null }),
}));
