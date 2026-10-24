export abstract class TracerPort {
  abstract inSpan<T>(
    name: string,
    attributes: Readonly<Record<string, string>>,
    fn: () => Promise<T>,
  ): Promise<T>;
}
