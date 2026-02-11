import { query } from '@anthropic-ai/claude-agent-sdk'
import * as Sentry from '@sentry/nextjs'

const SYSTEM_PROMPT = `You are a helpful personal assistant designed to help with general research, questions, and tasks.

Your role is to:
- Answer questions on any topic accurately and thoroughly
- Help with research by searching the web for current information
- Assist with writing, editing, and brainstorming
- Provide explanations and summaries of complex topics
- Help solve problems and think through decisions

Guidelines:
- Be friendly, clear, and conversational
- Use web search when you need current information, facts you're unsure about, or real-time data
- Keep responses concise but complete - expand when the topic warrants depth
- Use markdown formatting when it helps readability (bullet points, code blocks, etc.)
- Be honest when you don't know something and offer to search for answers`

interface MessageInput {
  role: 'user' | 'assistant'
  content: string
}

export async function POST(request: Request) {
  const requestStartTime = Date.now()

  try {
    Sentry.logger.info('chat_api_request_received', {
      timestamp: new Date().toISOString(),
      method: request.method,
      url: request.url,
    })

    // Increment API request counter
    Sentry.metrics.increment('chat.api.requests', 1, {
      tags: { endpoint: 'chat' }
    })

    const { messages } = await request.json() as { messages: MessageInput[] }

    if (!messages || !Array.isArray(messages)) {
      Sentry.logger.warn('chat_api_invalid_request', {
        reason: 'missing_messages_array'
      })

      Sentry.metrics.increment('chat.api.errors', 1, {
        tags: { error_type: 'validation', reason: 'missing_messages' }
      })

      return new Response(
        JSON.stringify({ error: 'Messages array is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Get the last user message
    const lastUserMessage = messages.filter(m => m.role === 'user').pop()
    if (!lastUserMessage) {
      Sentry.logger.warn('chat_api_invalid_request', {
        reason: 'no_user_message'
      })

      Sentry.metrics.increment('chat.api.errors', 1, {
        tags: { error_type: 'validation', reason: 'no_user_message' }
      })

      return new Response(
        JSON.stringify({ error: 'No user message found' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    Sentry.logger.info('chat_message_processing', {
      message_count: messages.length,
      user_message_length: lastUserMessage.content.length,
    })

    // Track message count
    Sentry.metrics.increment('chat.messages.total', 1, {
      tags: { role: 'user' }
    })

    // Track message length distribution
    Sentry.metrics.distribution('chat.message.length', lastUserMessage.content.length, {
      unit: 'character',
      tags: { role: 'user' }
    })

    // Build conversation context
    const conversationContext = messages
      .slice(0, -1) // Exclude the last message since we pass it as the prompt
      .map((m: MessageInput) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n')

    const fullPrompt = conversationContext
      ? `${SYSTEM_PROMPT}\n\nPrevious conversation:\n${conversationContext}\n\nUser: ${lastUserMessage.content}`
      : `${SYSTEM_PROMPT}\n\nUser: ${lastUserMessage.content}`

    // Create a streaming response
    const encoder = new TextEncoder()
    const streamStartTime = Date.now()
    let toolUsageCount = 0
    let responseTokens = 0

    const stream = new ReadableStream({
      async start(controller) {
        try {
          Sentry.logger.info('chat_stream_started', {
            conversation_length: messages.length
          })

          // Use the claude-agent-sdk query function with all default tools enabled
          for await (const message of query({
            prompt: fullPrompt,
            options: {
              maxTurns: 10,
              // Use the preset to enable all Claude Code tools including WebSearch
              tools: { type: 'preset', preset: 'claude_code' },
              // Bypass all permission checks for automated tool execution
              permissionMode: 'bypassPermissions',
              allowDangerouslySkipPermissions: true,
              // Enable partial messages for real-time text streaming
              includePartialMessages: true,
              // Set working directory to the app's directory for sandboxing
              cwd: process.cwd(),
            }
          })) {
            // Handle streaming text deltas (partial messages)
            if (message.type === 'stream_event' && 'event' in message) {
              const event = message.event
              // Handle content block delta events for text streaming
              if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'text_delta', text: event.delta.text })}\n\n`
                ))
              }
            }

            // Send tool start events from assistant messages
            if (message.type === 'assistant' && 'message' in message) {
              const content = message.message?.content
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'tool_use') {
                    toolUsageCount++

                    Sentry.logger.info('chat_tool_invoked', {
                      tool_name: block.name,
                      tool_id: block.id
                    })

                    // Track tool usage metrics
                    Sentry.metrics.increment('chat.tools.invocations', 1, {
                      tags: { tool_name: block.name }
                    })

                    controller.enqueue(encoder.encode(
                      `data: ${JSON.stringify({ type: 'tool_start', tool: block.name })}\n\n`
                    ))
                  }
                }
              }
            }

            // Send tool progress updates
            if (message.type === 'tool_progress') {
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'tool_progress', tool: message.tool_name, elapsed: message.elapsed_time_seconds })}\n\n`
              ))
            }

            // Signal completion
            if (message.type === 'result' && message.subtype === 'success') {
              const streamDuration = Date.now() - streamStartTime

              Sentry.logger.info('chat_stream_completed', {
                duration_ms: streamDuration,
                tool_count: toolUsageCount,
                success: true
              })

              // Track stream duration
              Sentry.metrics.distribution('chat.stream.duration', streamDuration, {
                unit: 'millisecond',
                tags: { status: 'success' }
              })

              // Track tools used per request
              Sentry.metrics.distribution('chat.tools.per_request', toolUsageCount, {
                unit: 'count'
              })

              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'done' })}\n\n`
              ))
            }

            // Handle errors
            if (message.type === 'result' && message.subtype !== 'success') {
              Sentry.logger.error('chat_query_failed', {
                subtype: message.subtype
              })

              Sentry.metrics.increment('chat.api.errors', 1, {
                tags: { error_type: 'query_failed', subtype: message.subtype }
              })

              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'error', message: 'Query did not complete successfully' })}\n\n`
              ))
            }
          }

          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()

          // Track successful API request
          const totalDuration = Date.now() - requestStartTime
          Sentry.metrics.distribution('chat.api.duration', totalDuration, {
            unit: 'millisecond',
            tags: { status: 'success' }
          })
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error'

          Sentry.logger.error('chat_stream_error', {
            error: errorMessage,
            stack: error instanceof Error ? error.stack : undefined
          })

          Sentry.metrics.increment('chat.api.errors', 1, {
            tags: { error_type: 'stream_error' }
          })

          console.error('Stream error:', error)
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: 'error', message: 'Stream error occurred' })}\n\n`
          ))
          controller.close()
        }
      }
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const totalDuration = Date.now() - requestStartTime

    Sentry.logger.error('chat_api_error', {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      duration_ms: totalDuration
    })

    Sentry.metrics.increment('chat.api.errors', 1, {
      tags: { error_type: 'request_error' }
    })

    Sentry.metrics.distribution('chat.api.duration', totalDuration, {
      unit: 'millisecond',
      tags: { status: 'error' }
    })

    console.error('Chat API error:', error)

    return new Response(
      JSON.stringify({ error: 'Failed to process chat request. Check server logs for details.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
