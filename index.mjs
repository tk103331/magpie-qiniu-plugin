const PROVIDER = "qiniu"
const BASE = "https://api.qnaigc.com/v1"

const SDK = "@ai-sdk/openai-compatible"

// Default models shown before login; the provider hook replaces them with
// the account's own list once signed in.
const DEFAULT_MODELS = [
  { id: "deepseek/deepseek-v3.1", name: "DeepSeek V3.1", context: 128000, output: 32000 },
  { id: "qwen3-coder-480b-a35b-instruct", name: "Qwen3 Coder 480B", context: 262000, output: 4096 },
  { id: "kimi-k2", name: "Kimi K2", context: 128000, output: 128000 },
  { id: "glm-4.5", name: "GLM 4.5", context: 131072, output: 98304 },
]

// ---- capability detection ----------------------------------------------------

const VISION_KEYS = ["vl", "vision", "omni", "multimodal"]
const REASON_KEYS = ["r1", "thinking", "reason"]

function hasVision(id) {
  const s = id.toLowerCase()
  return VISION_KEYS.some((k) => s.includes(k))
}

function hasReasoning(id) {
  const s = id.toLowerCase()
  return REASON_KEYS.some((k) => s.includes(k))
}

// displayName turns an id like "deepseek/deepseek-v4-flash" into
// "DeepSeek V4 Flash".
function displayName(id) {
  const bare = id.includes("/") ? id.split("/").pop() : id
  return bare
    .split(/[-._]/)
    .map((w) => {
      if (/^\d/.test(w)) return w
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join(" ")
}

// configModel is a model entry for the config hook.
function configModel(m) {
  const vision = hasVision(m.id)
  const reasoning = hasReasoning(m.id)
  return {
    name: m.name || displayName(m.id),
    limit: { context: m.context || 0, output: m.output || 0 },
    tool_call: true,
    ...(vision ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    ...(reasoning ? { reasoning: true } : {}),
  }
}

// runtimeModel is a model entry for the provider.models hook.
function runtimeModel(m) {
  const vision = hasVision(m.id)
  const reasoning = hasReasoning(m.id)
  const ctx = m.context || 0
  const out = m.output || 0
  return {
    id: m.id,
    providerID: PROVIDER,
    name: m.name || displayName(m.id),
    api: { id: m.id, url: BASE, npm: SDK },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: ctx, output: out },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: vision,
      toolcall: true,
      input: { text: true, image: vision, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

// ---- plugin ------------------------------------------------------------------

export const QiniuAuthPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "Qiniu",
      npm: SDK,
      api: BASE,
      models: Object.fromEntries(
        DEFAULT_MODELS.map((m) => [m.id, configModel(m)]),
      ),
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [
      { type: "api", label: "Qiniu API key", placeholder: "sk-…" },
    ],
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return {}
      return {
        baseURL: BASE,
        apiKey: auth.key,
        async fetch(input, init) {
          const headers = new Headers(init?.headers)
          headers.set("authorization", `Bearer ${auth.key}`)
          return fetch(input, { ...init, headers })
        },
      }
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      if (auth?.type !== "api") return provider.models
      try {
        const res = await fetch(`${BASE}/models`, {
          headers: { authorization: `Bearer ${auth.key}` },
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) return provider.models
        const body = await res.json()
        const data = Array.isArray(body?.data) ? body.data : []
        if (!data.length) return provider.models
        return Object.fromEntries(
          data
            .filter((m) => m && m.id)
            .map((m) => [
              m.id,
              runtimeModel({
                id: m.id,
                name: displayName(m.id),
                context: m.context_length || 0,
                output: m.max_tokens || 0,
              }),
            ]),
        )
      } catch {
        return provider.models
      }
    },
  },
})
