import type { Registry } from 'prom-client';

type LabelSet = Readonly<Record<string, string>>;

const sameLabels = (actual: Readonly<Record<string, unknown>>, expected: LabelSet): boolean => {
  const actualKeys = Object.keys(actual).filter((key) => key !== 'le');
  return (
    actualKeys.length === Object.keys(expected).length &&
    actualKeys.every((key) => actual[key] === expected[key])
  );
};

const sampleNameOf = (value: object, fallback: string): string => {
  const name: unknown = Reflect.get(value, 'metricName');
  return typeof name === 'string' ? name : fallback;
};

export const sampleValue = async (
  registry: Registry,
  metricName: string,
  labels: LabelSet = {},
  sampleName: string = metricName,
): Promise<number> => {
  const metric = registry.getSingleMetric(metricName);
  if (metric === undefined) {
    throw new Error(`metric ${metricName} is not registered`);
  }
  const data = await metric.get();
  const sample = data.values.find(
    (value) => sampleNameOf(value, metricName) === sampleName && sameLabels(value.labels, labels),
  );
  return sample?.value ?? 0;
};
