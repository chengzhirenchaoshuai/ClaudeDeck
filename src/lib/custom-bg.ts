/** 自定义背景图：上传时压缩 */

/** 最长边与体积上限：设置整体存在 localStorage（约 5MB），原图常常超出 */
const BG_MAX_SIDE = 2560;
const BG_MAX_CHARS = 1_500_000;

/** 把上传的图片缩放到 BG_MAX_SIDE 以内并转成 WebP data URL，体积超限时逐步降低质量 */
export async function compressBackground(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, BG_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let url = '';
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    url = canvas.toDataURL('image/webp', quality);
    if (url.length <= BG_MAX_CHARS) break;
  }
  return url;
}
