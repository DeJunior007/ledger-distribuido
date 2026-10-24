export interface OutboxGauges {
  pending: number;
  parked: number;
  stuck: number;
  lagSeconds: number;
}
