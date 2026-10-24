export interface HouseAccountRecordProps {
  id: string;
  currency: string;
  purpose: string;
  createdAt: Date;
}

export class HouseAccountRecord {
  id: string;
  currency: string;
  purpose: string;
  createdAt: Date;

  constructor(props: HouseAccountRecordProps) {
    this.id = props.id;
    this.currency = props.currency;
    this.purpose = props.purpose;
    this.createdAt = props.createdAt;
  }
}
