/** Delivery contract outcome; not a model-generated quality score. */
export interface TaskOutcome {
  taskOutcome: 'full' | 'degraded' | 'failed';
  reasonCodes: string[];
}
