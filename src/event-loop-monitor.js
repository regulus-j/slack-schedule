export function startEventLoopLagMonitor({
  logger,
  intervalMs = 1000,
  warnAfterMs = 200,
} = {}) {
  if (!logger) return () => {}

  let expectedAt = Date.now() + intervalMs
  const timer = setInterval(() => {
    const now = Date.now()
    const lagMs = now - expectedAt
    expectedAt = now + intervalMs

    if (lagMs >= warnAfterMs) {
      logger.warn('event_loop_lag_detected', {
        lagMs,
        intervalMs,
        warnAfterMs,
      })
    }
  }, intervalMs)

  timer.unref?.()
  return () => clearInterval(timer)
}
