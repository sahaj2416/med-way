const { runAsync, getAsync } = require('../db/database');

/**
 * Automated Telemetry Retention Pruner.
 * Enforces a sliding-window retention policy on ambulance_location_history to prevent
 * unbounded database growth while preserving mission reconstruction records.
 */
class TelemetryPruner {
  constructor() {
    this.timer = null;
    this.lastPrunedCount = 0;
    this.lastPrunedAt = null;
  }

  /**
   * Prunes telemetry entries older than retentionDays for completed missions,
   * and caps completed dispatch telemetry to the latest maxPerDispatch waypoints.
   */
  async pruneTelemetryHistory(retentionDays = 7, maxPerDispatch = 100) {
    try {
      // 1. Delete telemetry from completed missions older than retentionDays
      const oldDeleteRes = await runAsync(
        `DELETE FROM ambulance_location_history
         WHERE recorded_at < datetime('now', '-' || ? || ' days')
           AND dispatch_id IN (SELECT id FROM dispatches WHERE status = 'COMPLETED')`,
        [retentionDays]
      );

      // 2. Cap completed mission waypoints to maxPerDispatch to prevent bloat
      const excessDeleteRes = await runAsync(
        `DELETE FROM ambulance_location_history
         WHERE id NOT IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY dispatch_id ORDER BY id DESC) as rn
             FROM ambulance_location_history
             WHERE dispatch_id IS NOT NULL
           ) WHERE rn <= ?
         )
         AND dispatch_id IN (SELECT id FROM dispatches WHERE status = 'COMPLETED')`,
        [maxPerDispatch]
      );

      const totalPruned = (oldDeleteRes?.changes || 0) + (excessDeleteRes?.changes || 0);
      this.lastPrunedCount = totalPruned;
      this.lastPrunedAt = new Date().toISOString();

      if (totalPruned > 0) {
        console.log(`[TelemetryPruner] Pruned ${totalPruned} old/excess telemetry records from database.`);
      }

      return {
        success: true,
        prunedCount: totalPruned,
        prunedAt: this.lastPrunedAt
      };
    } catch (err) {
      console.error('[TelemetryPruner] Error during telemetry retention pruning:', err);
      return { success: false, error: err.message };
    }
  }

  startSchedule(intervalMs = 3600000) { // Default: Hourly
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(() => {
      this.pruneTelemetryHistory().catch(() => {});
    }, intervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stopSchedule() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStats() {
    return {
      lastPrunedCount: this.lastPrunedCount,
      lastPrunedAt: this.lastPrunedAt
    };
  }
}

const telemetryPruner = new TelemetryPruner();

module.exports = {
  TelemetryPruner,
  telemetryPruner
};
