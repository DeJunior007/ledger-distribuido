export type DatabaseCheck = (databaseUrl: string) => void | Promise<void>;

let currentUrl: string | undefined;

export const registerCurrentDatabase = (databaseUrl: string): void => {
  currentUrl = databaseUrl;
};

export const currentDatabaseUrl = (): string | undefined => currentUrl;

export const releaseCurrentDatabase = (): string | undefined => {
  const databaseUrl = currentUrl;
  currentUrl = undefined;
  return databaseUrl;
};

export const noConsistencyCheck: DatabaseCheck = () => undefined;

export const afterEachDatabaseCheck =
  (check: DatabaseCheck, fallbackUrl?: string): (() => Promise<void>) =>
  async () => {
    const databaseUrl = releaseCurrentDatabase() ?? fallbackUrl;
    if (databaseUrl !== undefined) {
      await check(databaseUrl);
    }
  };
