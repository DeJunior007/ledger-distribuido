export interface ReconciliationRunRecordProps {
  id: string;
  scope: string;
  walletId: string | null;
  consistent: boolean;
  checkedEntries: number;
  storedAmount: string | null;
  calculatedAmount: string | null;
  differenceAmount: string | null;
  currency: string | null;
  firstDivergentVersion: number | null;
  details: unknown;
  startedAt: Date;
  finishedAt: Date;
}

export class ReconciliationRunRecord {
  id: string;
  scope: string;
  walletId: string | null;
  consistent: boolean;
  checkedEntries: number;
  storedAmount: string | null;
  calculatedAmount: string | null;
  differenceAmount: string | null;
  currency: string | null;
  firstDivergentVersion: number | null;
  details: unknown;
  startedAt: Date;
  finishedAt: Date;

  constructor(props: ReconciliationRunRecordProps) {
    this.id = props.id;
    this.scope = props.scope;
    this.walletId = props.walletId;
    this.consistent = props.consistent;
    this.checkedEntries = props.checkedEntries;
    this.storedAmount = props.storedAmount;
    this.calculatedAmount = props.calculatedAmount;
    this.differenceAmount = props.differenceAmount;
    this.currency = props.currency;
    this.firstDivergentVersion = props.firstDivergentVersion;
    this.details = props.details;
    this.startedAt = props.startedAt;
    this.finishedAt = props.finishedAt;
  }
}
