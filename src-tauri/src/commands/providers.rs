//! API 服务商：配置读写（AES-GCM 加密存储）、连接测试、会话环境注入、余额查询。

use crate::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelMapping {
    pub(crate) tier: String,
    pub(crate) provider_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiProvider {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) base_url: String,
    pub(crate) api_format: String,
    pub(crate) api_key: Option<String>,
    pub(crate) model_mappings: Vec<ModelMapping>,
    pub(crate) extra_env: Option<HashMap<String, String>>,
    pub(crate) proxy_url: Option<String>,
    pub(crate) preset: Option<String>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProvidersFile {
    pub(crate) version: u32,
    pub(crate) active_provider_id: Option<String>,
    pub(crate) providers: Vec<ApiProvider>,
}

impl Default for ProvidersFile {
    fn default() -> Self {
        Self {
            version: 1,
            active_provider_id: None,
            providers: vec![],
        }
    }
}

pub(crate) fn providers_path() -> Result<std::path::PathBuf, String> {
    app_paths::config_path("providers.json")
}

// --- Provider credential encryption (TK-303) ---
// Provider JSON is AES-GCM encrypted with a persistent random master key, sealed
// with DPAPI for the current OS user; legacy raw key files are migrated on load.
// Export/import still operates on explicit user-requested plaintext JSON.

use rand::RngCore;
use base64::Engine;

pub(crate) const ENC_MAGIC: &str = "TENC1:";
pub(crate) const PROVIDER_KEY_FILE: &str = "providers.key";
pub(crate) const MASTER_KEY_LEN: usize = 32;
pub(crate) const DPAPI_MAGIC: &[u8] = b"TDP1";

#[repr(C)]
pub(crate) struct DataBlob {
    pub(crate) cb_data: u32,
    pub(crate) pb_data: *mut u8,
}

#[link(name = "Crypt32")]
unsafe extern "system" {
    fn CryptProtectData(
        data_in: *const DataBlob,
        description: *const u16,
        optional_entropy: *const DataBlob,
        reserved: *mut std::ffi::c_void,
        prompt: *const std::ffi::c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
    fn CryptUnprotectData(
        data_in: *const DataBlob,
        description: *mut *mut u16,
        optional_entropy: *const DataBlob,
        reserved: *mut std::ffi::c_void,
        prompt: *const std::ffi::c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
}

#[link(name = "Kernel32")]
unsafe extern "system" {
    fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

pub(crate) fn dpapi_transform(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;
    let input_blob = DataBlob {
        cb_data: input.len() as u32,
        pb_data: input.as_ptr() as *mut u8,
    };
    let mut output_blob = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &input_blob, std::ptr::null(), std::ptr::null(), std::ptr::null_mut(),
                std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output_blob,
            )
        } else {
            CryptUnprotectData(
                &input_blob, std::ptr::null_mut(), std::ptr::null(), std::ptr::null_mut(),
                std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output_blob,
            )
        }
    };
    if ok == 0 || output_blob.pb_data.is_null() {
        return Err("Windows credential protection failed".to_string());
    }
    let output = unsafe {
        let value = std::slice::from_raw_parts(output_blob.pb_data, output_blob.cb_data as usize).to_vec();
        let _ = LocalFree(output_blob.pb_data as *mut std::ffi::c_void);
        value
    };
    Ok(output)
}

pub(crate) fn seal_master_key(key: &[u8; MASTER_KEY_LEN]) -> Result<Vec<u8>, String> {
    let mut stored = DPAPI_MAGIC.to_vec();
    stored.extend_from_slice(&dpapi_transform(key, true)?);
    Ok(stored)
}

pub(crate) fn open_master_key(raw: &[u8]) -> Result<[u8; MASTER_KEY_LEN], String> {
    let plain = if raw.starts_with(DPAPI_MAGIC) {
        dpapi_transform(&raw[DPAPI_MAGIC.len()..], false)?
    } else {
        raw.to_vec()
    };
    plain.try_into().map_err(|_| "Invalid provider master key".to_string())
}

pub(crate) fn harden_path_permissions(_path: &std::path::Path) {}

pub(crate) fn provider_key_path() -> Result<std::path::PathBuf, String> {
    app_paths::config_path(PROVIDER_KEY_FILE)
}

/// Load the persistent master key, generating and persisting it on first use.
pub(crate) fn load_or_create_master_key() -> Result<[u8; MASTER_KEY_LEN], String> {
    let path = provider_key_path()?;
    if path.exists() {
        let raw = std::fs::read(&path).map_err(|e| format!("读取密钥失败: {}", e))?;
        let key = open_master_key(&raw)?;
        if !raw.starts_with(DPAPI_MAGIC) {
            std::fs::write(&path, seal_master_key(&key)?)
                .map_err(|e| format!("Failed to migrate provider key protection: {}", e))?;
        }
        return Ok(key);
    }
    let mut key = [0u8; MASTER_KEY_LEN];
    rand::thread_rng().fill_bytes(&mut key);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建目录: {}", e))?;
    }
    std::fs::write(&path, seal_master_key(&key)?)
        .map_err(|e| format!("写入密钥失败: {}", e))?;
    harden_path_permissions(&path);
    Ok(key)
}

pub(crate) fn encrypt_providers(plain: &str) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    let key = load_or_create_master_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
        .map_err(|e| format!("加密失败: {}", e))?;
    let mut blob = Vec::with_capacity(12 + ciphertext.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    Ok(format!(
        "{}{}",
        ENC_MAGIC,
        base64::engine::general_purpose::STANDARD.encode(&blob)
    ))
}

pub(crate) fn decrypt_providers(stored: &str) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    let Some(b64) = stored.strip_prefix(ENC_MAGIC) else {
        // Legacy plaintext file — will be re-encrypted on the next save.
        return Ok(stored.to_string());
    };
    let key = load_or_create_master_key()?;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("密文解码失败: {}", e))?;
    if blob.len() < 12 {
        return Err("密文长度不足".to_string());
    }
    let (nonce, ct) = blob.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| "解密失败：密钥不匹配或数据被篡改".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("无效的 UTF-8: {}", e))
}

#[tauri::command]
pub(crate) fn load_providers() -> Result<ProvidersFile, String> {
    let path = providers_path()?;
    if !path.exists() {
        return Ok(ProvidersFile::default());
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("Cannot read providers: {}", e))?;
    let json = decrypt_providers(&raw)?;
    serde_json::from_str(&json).map_err(|e| format!("Cannot parse providers: {}", e))
}

#[tauri::command]
pub(crate) fn save_providers(data: ProvidersFile) -> Result<(), String> {
    let path = providers_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create dir: {}", e))?;
    }
    let json =
        serde_json::to_string_pretty(&data).map_err(|e| format!("Serialize error: {}", e))?;
    let sealed = encrypt_providers(&json)?;
    std::fs::write(&path, sealed).map_err(|e| format!("Write error: {}", e))?;
    harden_path_permissions(&path);
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StepResult {
    pub(crate) ok: bool,
    pub(crate) message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ConnectionTestResult {
    pub(crate) connectivity: StepResult,
    pub(crate) auth: StepResult,
    pub(crate) model: StepResult,
}

pub(crate) fn provider_messages_endpoint(base_url: &str, api_format: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let lower = base.to_lowercase();
    if api_format.eq_ignore_ascii_case("openai") {
        // 已是完整地址则原样使用，否则（包括以 /v1 结尾的）补上 /chat/completions
        if lower.ends_with("/chat/completions") {
            base.to_string()
        } else {
            format!("{}/chat/completions", base)
        }
    } else if lower.ends_with("/v1/messages") {
        base.to_string()
    } else if lower.ends_with("/v1") {
        format!("{}/messages", base)
    } else {
        format!("{}/v1/messages", base)
    }
}

#[tauri::command]
pub(crate) async fn test_provider_connection(
    base_url: String,
    api_format: String,
    api_key: String,
    model: String,
    proxy_url: Option<String>,
) -> Result<ConnectionTestResult, String> {
    // If provider has a proxy configured, build a client that uses it.
    // Otherwise fall back to the smart proxy detection.
    let client = if let Some(ref purl) = proxy_url {
        if !purl.is_empty() {
            if let Ok(proxy) = reqwest::Proxy::all(purl) {
                if is_proxy_reachable(purl).await {
                    eprintln!("test_provider_connection: using configured provider proxy");
                    reqwest::Client::builder()
                        .connect_timeout(std::time::Duration::from_secs(10))
                        .timeout(std::time::Duration::from_secs(30))
                        .no_proxy()
                        .proxy(proxy)
                        .build()
                        .unwrap_or_default()
                } else {
                    eprintln!("test_provider_connection: configured provider proxy unreachable, direct");
                    build_smart_http_client(
                        std::time::Duration::from_secs(10),
                        std::time::Duration::from_secs(30),
                    )
                    .await
                }
            } else {
                build_smart_http_client(
                    std::time::Duration::from_secs(10),
                    std::time::Duration::from_secs(30),
                )
                .await
            }
        } else {
            build_smart_http_client(
                std::time::Duration::from_secs(10),
                std::time::Duration::from_secs(30),
            )
            .await
        }
    } else {
        build_smart_http_client(
            std::time::Duration::from_secs(10),
            std::time::Duration::from_secs(30),
        )
        .await
    };

    let skipped = StepResult {
        ok: false,
        message: "Skipped".to_string(),
    };

    // Step 1: Connectivity — HEAD request to base URL without auth
    let connectivity_url = provider_messages_endpoint(&base_url, &api_format);
    let conn_result = client
        .head(&connectivity_url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;
    let connectivity = match conn_result {
        Ok(_resp) => StepResult {
            ok: true,
            message: "Reachable".to_string(),
        },
        Err(e) => {
            return Ok(ConnectionTestResult {
                connectivity: StepResult {
                    ok: false,
                    message: format!("Unreachable: {}", e),
                },
                auth: skipped.clone(),
                model: skipped,
            });
        }
    };

    // Steps 2+3: Auth + Model — single request with the REAL model name.
    // Previously used a dummy "test-auth-probe" model for auth, then the real model
    // for model validation. But some providers (e.g. MiMo) tie model access to API
    // key permissions and return 403 for unknown models, causing false auth failures.
    // Now we send one request and derive both auth and model status from it.
    let test_body = serde_json::json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "hi"}]
    });
    let mut test_req = client
        .post(&connectivity_url)
        .header("Content-Type", "application/json")
        .json(&test_body)
        .timeout(std::time::Duration::from_secs(15));
    if api_format == "openai" {
        test_req = test_req.header("Authorization", format!("Bearer {}", api_key));
    } else {
        test_req = test_req
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01");
    }
    let test_resp = test_req.send().await;
    let (auth, model_step) = match test_resp {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if status == 401 {
                // Definitely auth failure
                let text = resp.text().await.unwrap_or_default();
                (
                    StepResult {
                        ok: false,
                        message: format!("HTTP {} — {}", status, text.chars().take(200).collect::<String>()),
                    },
                    skipped,
                )
            } else if status == 403 {
                // 403 is ambiguous: could be auth failure OR model access restriction.
                // Read body to disambiguate.
                let text = resp.text().await.unwrap_or_default();
                let text_lower = text.to_lowercase();
                let is_auth_error = text_lower.contains("invalid")
                    && (text_lower.contains("api key") || text_lower.contains("api_key")
                        || text_lower.contains("token") || text_lower.contains("credentials"));
                if is_auth_error {
                    (
                        StepResult { ok: false, message: format!("HTTP 403 — {}", text.chars().take(200).collect::<String>()) },
                        skipped,
                    )
                } else {
                    // 403 but not clearly auth — treat as auth OK + model issue
                    (
                        StepResult { ok: true, message: "Authenticated (HTTP 403 — access restricted)".to_string() },
                        StepResult { ok: false, message: format!("HTTP 403 — {}", text.chars().take(200).collect::<String>()) },
                    )
                }
            } else if (200..300).contains(&status) {
                (
                    StepResult { ok: true, message: format!("Authenticated (HTTP {})", status) },
                    StepResult { ok: true, message: format!("Model OK (HTTP {})", status) },
                )
            } else {
                // 400, 404, 429, 500, etc. — auth is OK (server processed the request)
                let text = resp.text().await.unwrap_or_default();
                let text_lower = text.to_lowercase();
                let is_model_error = (status == 404)
                    || (text_lower.contains("model")
                        && (text_lower.contains("not found")
                            || text_lower.contains("not_found")
                            || text_lower.contains("does not exist")
                            || text_lower.contains("invalid model")
                            || text_lower.contains("invalid_model")));
                let model_result = if is_model_error {
                    StepResult { ok: false, message: format!("HTTP {} — {}", status, text.chars().take(200).collect::<String>()) }
                } else {
                    StepResult { ok: true, message: format!("Model accepted (HTTP {})", status) }
                };
                (
                    StepResult { ok: true, message: format!("Authenticated (HTTP {})", status) },
                    model_result,
                )
            }
        }
        Err(e) => (
            StepResult { ok: false, message: format!("Request failed: {}", e) },
            skipped,
        ),
    };

    Ok(ConnectionTestResult {
        connectivity,
        auth,
        model: model_step,
    })
}

/// (extra_env, keys_to_remove, extra_args)
pub(crate) type ProviderEnv = (HashMap<String, String>, Vec<String>, Vec<String>);

/// Resolve provider env vars and CLI args from a provider_id.
/// Returns (extra_env, keys_to_remove, extra_args).
pub(crate) fn resolve_provider_env(
    provider_id: Option<&str>,
) -> Result<ProviderEnv, String> {
    let Some(pid) = provider_id else {
        return Ok((HashMap::new(), vec![], vec![]));
    };

    let providers_file = load_providers()?;
    let provider = providers_file
        .providers
        .iter()
        .find(|p| p.id == pid)
        .ok_or_else(|| format!("Provider '{}' not found", pid))?;

    let mut env = HashMap::new();

    // Set base URL
    if !provider.base_url.is_empty() {
        env.insert("ANTHROPIC_BASE_URL".to_string(), provider.base_url.clone());
    }

    // Set API key (plaintext, no encryption).
    // Only set ANTHROPIC_API_KEY — do NOT set ANTHROPIC_AUTH_TOKEN.
    // AUTH_TOKEN triggers OAuth/Bearer auth in the CLI, which third-party
    // providers don't support. API_KEY uses the correct x-api-key header.
    if let Some(ref key) = provider.api_key {
        if !key.is_empty() {
            env.insert("ANTHROPIC_API_KEY".to_string(), key.clone());
        }
    }

    // Merge extra_env (empty string = delete from child process env)
    let mut keys_to_remove = Vec::new();
    if let Some(ref extra) = provider.extra_env {
        for (k, v) in extra {
            if v.is_empty() {
                keys_to_remove.push(k.clone());
            } else {
                env.insert(k.clone(), v.clone());
            }
        }
    }

    // Inject provider-level proxy URL into CLI subprocess env.
    // This takes highest priority — if set, it overrides all other proxy sources.
    if let Some(ref proxy_url) = provider.proxy_url {
        if !proxy_url.is_empty() {
            for key in &["https_proxy", "http_proxy", "HTTPS_PROXY", "HTTP_PROXY"] {
                env.insert(key.to_string(), proxy_url.clone());
            }
            if proxy_url.starts_with("socks") {
                env.insert("all_proxy".to_string(), proxy_url.clone());
                env.insert("ALL_PROXY".to_string(), proxy_url.clone());
            }
        }
    }

    // Auto-disable experimental betas for non-Anthropic providers (#69).
    // Beta flags (cache_control.scope, structured-outputs, eager_input_streaming)
    // are only supported by Anthropic's native API. Bedrock, Vertex, and all
    // third-party proxies (including those that route through Bedrock internally)
    // will return 400 errors if these flags are present.
    // Only keep betas enabled when the base URL is explicitly Anthropic's native API.
    let base_lower = provider.base_url.to_lowercase();
    let is_native_anthropic = base_lower.is_empty()
        || base_lower.contains("api.anthropic.com");
    if !is_native_anthropic {
        env.entry("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS".to_string())
            .or_insert_with(|| "1".to_string());
    }

    // No extra CLI args needed — env vars set on the process take precedence.
    // Previously we used --setting-sources project,local to skip user settings,
    // but that broke directories without .claude/ (e.g. empty/new folders) because
    // the CLI lost workspace trust and other user-level config.
    let extra_args: Vec<String> = vec![];

    Ok((env, keys_to_remove, extra_args))
}
/// 查询供应商账户余额。目前只支持 DeepSeek（GET https://api.deepseek.com/user/balance）。
/// API Key 只会发往 deepseek.com 的主机，其他主机一律拒绝。
#[tauri::command]
pub(crate) async fn get_provider_balance(provider_id: String) -> Result<Value, String> {
    let file = load_providers()?;
    let provider = file
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| "未找到该供应商".to_string())?;
    let key = provider
        .api_key
        .as_deref()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| "该供应商未配置 API Key".to_string())?;
    let url = reqwest::Url::parse(&provider.base_url).map_err(|_| "供应商地址无效".to_string())?;
    let host = url.host_str().unwrap_or("").to_string();
    if host != "api.deepseek.com" && !host.ends_with(".deepseek.com") {
        return Err("该供应商暂不支持余额查询".to_string());
    }
    let endpoint = format!("https://{}/user/balance", host);
    let client = build_smart_http_client(
        std::time::Duration::from_secs(10),
        std::time::Duration::from_secs(20),
    )
    .await;
    let resp = client
        .get(&endpoint)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| format!("解析响应失败: {}", e))?;
    if !status.is_success() {
        let msg = body["error"]["message"].as_str().unwrap_or("请求被拒绝");
        return Err(format!("HTTP {}: {}", status.as_u16(), msg));
    }
    let balances: Vec<Value> = body["balance_infos"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|b| {
            serde_json::json!({
                "currency": b["currency"],
                "total": b["total_balance"],
                "granted": b["granted_balance"],
                "toppedUp": b["topped_up_balance"],
            })
        })
        .collect();
    Ok(serde_json::json!({
        "isAvailable": body["is_available"].as_bool().unwrap_or(false),
        "balances": balances,
    }))
}
