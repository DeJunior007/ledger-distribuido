export class RollbackSignal<T> extends Error {
  constructor(readonly result: T) {
    super('rollback');
    this.name = 'RollbackSignal';
  }
}
