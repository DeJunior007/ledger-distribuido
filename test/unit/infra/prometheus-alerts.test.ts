import { beforeAll, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  METRIC_PREFIX,
  createMetricsRegistry,
} from '@infrastructure/observability/metrics.registry';

const ALERTS_PATH = 'infra/prometheus/alerts.yml';
const MOUNTED_ALERTS_PATH = '/etc/prometheus/alerts.yml';
const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'] as const;
const SEVERITIES = ['warning', 'critical'] as const;
const REPLICA_TARGET = /count\(up\{job="jungle"\} == 1\) or vector\(0\)\) < (\d+)/;

const ruleSchema = z.object({
  alert: z.string().regex(/^Jungle[A-Za-z]+$/),
  expr: z.string().min(1),
  for: z.string().regex(/^\d+[smh]$/),
  labels: z.object({ severity: z.enum(SEVERITIES) }),
  annotations: z.object({ summary: z.string().min(1), description: z.string().min(1) }),
});

const alertsSchema = z.object({
  groups: z.array(z.object({ name: z.string(), rules: z.array(ruleSchema).min(1) })).min(1),
});

const prometheusSchema = z.object({
  rule_files: z.array(z.string()),
  scrape_configs: z.array(
    z.object({ dns_sd_configs: z.array(z.object({ names: z.array(z.string()) })) }),
  ),
});

const composeSchema = z.object({
  services: z.record(
    z.object({
      volumes: z.array(z.string()).optional(),
      deploy: z.object({ replicas: z.number().int().positive() }).optional(),
    }),
  ),
});

const loadPrometheus = async (): Promise<z.infer<typeof prometheusSchema>> =>
  prometheusSchema.parse(Bun.YAML.parse(await Bun.file('infra/prometheus/prometheus.yml').text()));

const loadCompose = async (): Promise<z.infer<typeof composeSchema>> =>
  composeSchema.parse(Bun.YAML.parse(await Bun.file('docker-compose.yml').text()));

type AlertRule = z.infer<typeof ruleSchema>;

let rules: readonly AlertRule[];

const registeredNames = async (): Promise<Set<string>> => {
  const metrics = await createMetricsRegistry().registry.getMetricsAsJSON();
  const names = metrics.flatMap((metric) =>
    String(metric.type) === 'histogram'
      ? HISTOGRAM_SUFFIXES.map((suffix) => `${metric.name}${suffix}`)
      : [metric.name],
  );
  return new Set(names);
};

const metricNamesOf = (expr: string): string[] =>
  [...expr.matchAll(new RegExp(`\\b${METRIC_PREFIX}[a-z0-9_]+`, 'g'))].map((match) => match[0]);

beforeAll(async () => {
  const parsed = alertsSchema.parse(Bun.YAML.parse(await Bun.file(ALERTS_PATH).text()));
  rules = parsed.groups.flatMap((group) => group.rules);
});

describe('prometheus alert rules', () => {
  it('keeps a short list of uniquely named rules', () => {
    const names = rules.map((rule) => rule.alert);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(6);
    expect(names.length).toBeLessThanOrEqual(8);
  });

  it('points every expression at a metric the registry exposes', async () => {
    const known = await registeredNames();
    for (const rule of rules) {
      for (const name of metricNamesOf(rule.expr)) {
        expect({ alert: rule.alert, name, known: known.has(name) }).toEqual({
          alert: rule.alert,
          name,
          known: true,
        });
      }
    }
  });

  it('expects as many targets as the compose file runs', async () => {
    const compose = await loadCompose();
    const prometheus = await loadPrometheus();
    const scraped = prometheus.scrape_configs.flatMap((job) =>
      job.dns_sd_configs.flatMap((config) => config.names),
    );
    const replicas = scraped.reduce(
      (total, name) => total + (compose.services[name]?.deploy?.replicas ?? 1),
      0,
    );
    const replicaRule = rules.find((rule) => rule.alert === 'JungleReplicaDown');
    const expected = REPLICA_TARGET.exec(replicaRule?.expr ?? '')?.[1];
    expect(expected).toBe(String(replicas));
    expect(replicaRule?.annotations.description).toContain(`de ${String(replicas)} réplicas`);
  });

  it('loads the rules file in prometheus and mounts it read only', async () => {
    const prometheus = await loadPrometheus();
    expect(prometheus.rule_files).toContain(MOUNTED_ALERTS_PATH);
    const compose = await loadCompose();
    expect(compose.services.prometheus?.volumes).toContain(
      `./${ALERTS_PATH}:${MOUNTED_ALERTS_PATH}:ro,z`,
    );
  });
});
