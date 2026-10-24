export type FaultPoint =
  | 'api.before_commit'
  | 'api.after_commit_before_response'
  | 'consumer.before_commit'
  | 'consumer.after_commit_before_ack'
  | 'outbox.after_claim_before_publish'
  | 'outbox.after_publish_before_mark'
  | 'scheduler.after_commit';

export abstract class FaultInjectorPort {
  abstract hit(point: FaultPoint): void;
}
