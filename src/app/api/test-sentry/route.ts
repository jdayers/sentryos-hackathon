import * as Sentry from '@sentry/nextjs'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    console.log('🧪 Sentry test endpoint called')

    // Test 1: Structured log with Sentry.logger
    Sentry.logger.info('test_log_triggered', {
      log_source: 'sentry_test_endpoint',
      timestamp: new Date().toISOString(),
      test_type: 'manual_trigger',
      message: 'User triggered test log'
    })

    // Test 2: Warning log
    Sentry.logger.warn('test_warning_triggered', {
      warning_type: 'test',
      severity: 'medium',
      message: 'This is a test warning from the API'
    })

    // Test 3: Console logs (captured by consoleLoggingIntegration)
    console.log('📝 Test console.log - this should appear in Sentry')
    console.warn('⚠️ Test console.warn - this should appear in Sentry')

    // Test 4: Metrics (Note: Metrics API is available in client/server runtime via instrumentation)
    // These will be tracked via the instrumentation we added in the chat API
    console.log('📊 Metrics are tracked automatically via instrumentation in production APIs')

    // Test 5: Breadcrumb
    Sentry.addBreadcrumb({
      message: 'Test breadcrumb added',
      level: 'info',
      data: {
        endpoint: '/api/test-sentry',
        action: 'test_execution',
      },
    })

    // Test 6: Capture a test message
    Sentry.captureMessage('Test message from Sentry test endpoint', {
      level: 'info',
      tags: {
        test_type: 'api_test',
        endpoint: 'test-sentry',
      },
      extra: {
        timestamp: new Date().toISOString(),
        test_number: 6,
      },
    })

    return NextResponse.json({
      success: true,
      message: 'Test events sent to Sentry successfully! 🎉',
      events_sent: {
        structured_logs: 2,
        console_logs: 3,
        breadcrumbs: 1,
        messages: 1,
      },
      note: 'Metrics are tracked automatically via instrumentation in the chat API and client-side interactions',
      check_sentry: 'https://sentry.io/organizations/kunal-test-org/projects/jeff-nextjs-hackathon/',
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    // Test 7: Error logging
    Sentry.logger.error('test_endpoint_error', {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    })

    Sentry.captureException(error)

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to send test events',
        details: errorMessage,
      },
      { status: 500 }
    )
  }
}
