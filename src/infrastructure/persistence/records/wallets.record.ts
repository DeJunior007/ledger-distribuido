export interface WalletRecordProps {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;

  constructor(props: WalletRecordProps) {
    this.id = props.id;
    this.playerId = props.playerId;
    this.currency = props.currency;
    this.balance = props.balance;
    this.version = props.version;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }
}
