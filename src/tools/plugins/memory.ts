/**
 * Memory Plugin — shared vector memory via the local memory-service.
 *
 * Talks to the memory-service (loopback HTTP), which owns embeddings and the
 * Qdrant collections that st-qdrant-memory (SillyTavern) also reads/writes,
 * so a bot's memory is continuous across ST and Discord.
 *
 * Behavior:
 * - Injects retrieved memories ONLY when the triggering message was authored
 *   by one of the configured users (not on bot mentions, timers, or random
 *   activations). The injected block is ephemeral — rebuilt per activation,
 *   never part of channel history.
 * - On those same turns, reports the user's and the bot's own recent channel
 *   messages to the service for saving. The service dedups by message id and
 *   buffers into ST-compatible chunks, so re-sending is harmless.
 *
 * Config (via plugin_config.memory in bot YAML):
 *   bot: mythos                     # memory-service bot key (selects collection)
 *   user_ids: ['7055...']           # users whose turns trigger retrieval/saving
 *   service_url: http://127.0.0.1:3102
 *   recent_messages: 30             # window for exclusions + save reporting
 *   injection_depth: 2              # targetDepth of the injected block
 *   request_timeout_ms: 3500
 *
 * The agent loop enriches the config with _recentMessagesRaw (structured
 * recent messages) and _botUserId — see loop.ts plugin injection gathering.
 */

import type { ToolPlugin, PluginStateContext, ContextInjection } from './types.js'

interface RawRecentMessage {
  id: string
  authorId?: string
  authorName?: string
  isBot: boolean
  content: string
  ts: number
  channelId?: string
  guildId?: string
}

// Replay cache so continuations of the same activation reuse the block:
// `${botId}:${triggeringMessageId}` → injections
const turnCache = new Map<string, ContextInjection[]>()
const TURN_CACHE_MAX = 50

async function callService(
  serviceUrl: string,
  path: string,
  body: unknown,
  timeoutMs: number
): Promise<Record<string, any>> {
  const response = await fetch(`${serviceUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`memory-service ${path}: ${response.status}`)
  }
  return await response.json() as Record<string, any>
}

const memoryPlugin: ToolPlugin = {
  name: 'memory',
  description: 'Shared vector memory (st-qdrant-memory compatible) via memory-service',
  tools: [],

  getContextInjections: async (context: PluginStateContext): Promise<ContextInjection[]> => {
    const config = context.pluginConfig
    const userIds: string[] = config?.user_ids || []
    if (!config?.bot || userIds.length === 0) return []

    const recent: RawRecentMessage[] | undefined = config._recentMessagesRaw
    if (!recent || recent.length === 0) return []

    // Gate: the triggering message must come from a configured user.
    const trigger = recent.find(m => m.id === context.currentMessageId)
    if (!trigger || trigger.isBot || !trigger.authorId || !userIds.includes(trigger.authorId)) {
      return []
    }

    const cacheKey = `${context.botId}:${context.currentMessageId}`
    const cached = turnCache.get(cacheKey)
    if (cached) return cached

    const serviceUrl = config.service_url || 'http://127.0.0.1:3102'
    const timeoutMs = config.request_timeout_ms || 3500

    // Report the exchange for saving (fire-and-forget; service dedups by id).
    const botUserId: string | undefined = config._botUserId
    const toSave = recent
      .filter(m => m.content && m.authorId &&
        ((userIds.includes(m.authorId) && !m.isBot) || (botUserId && m.authorId === botUserId)))
      .map(m => ({
        speaker_kind: botUserId && m.authorId === botUserId ? 'self' : 'user',
        discord_user_id: m.authorId,
        speaker_name: m.authorName,
        text: m.content,
        message_id: m.id,
        ts: m.ts,
        channel_id: m.channelId,
        guild_id: m.guildId,
      }))
    if (toSave.length > 0) {
      callService(serviceUrl, '/save', { bot: config.bot, messages: toSave }, timeoutMs)
        .catch(e => console.warn('[memory plugin] save failed:', e?.message || e))
    }

    try {
      const result = await callService(serviceUrl, '/retrieve', {
        bot: config.bot,
        query_text: trigger.content,
        exclude_message_ids: recent.map(m => m.id),
      }, timeoutMs)

      const formatted: string = typeof result.formatted === 'string' ? result.formatted : ''
      const injections: ContextInjection[] = formatted
        ? [{
            id: `memory-${context.currentMessageId}`,
            content: formatted,
            targetDepth: config.injection_depth ?? 2,
            priority: 20,
            asSystem: true,
          }]
        : []

      turnCache.set(cacheKey, injections)
      while (turnCache.size > TURN_CACHE_MAX) {
        const oldest = turnCache.keys().next().value
        if (oldest === undefined) break
        turnCache.delete(oldest)
      }
      return injections
    } catch (e) {
      // Fail open — never block the bot's turn on the memory system.
      console.warn('[memory plugin] retrieve failed:', (e as Error)?.message || e)
      return []
    }
  },
}

export default memoryPlugin
