import { businessRule, Logger, OperationOutcomeError } from '@medplum/core';
import Redis from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { AuthState } from '../oauth/middleware';

const ONE_DAY = 60 * 60 * 24;

export class ResourceCap {
  private readonly limiter: RateLimiterRedis;
  private readonly projectKey: string;

  private current?: RateLimiterRes;
  private readonly enabled: boolean;
  private readonly logger: Logger;

  private initPromise?: Promise<void>;

  constructor(redis: Redis, authState: AuthState, projectLimit: number, logger: Logger) {
    this.limiter = new RateLimiterRedis({
      keyPrefix: 'medplum:resource-cap:',
      storeClient: redis,
      points: projectLimit,
      duration: ONE_DAY,
    });
    this.projectKey = authState.project.id;

    this.logger = logger;
    this.enabled = authState.project.systemSetting?.find((s) => s.name === 'enableResourceCap')?.valueBoolean === true;
  }

  private async init(): Promise<void> {
    let currentStatus = await this.limiter.get(this.projectKey);
    if (!currentStatus) {
      // TODO: Fetch from DB
      const count = 0;
      currentStatus = await this.limiter.set(this.projectKey, count, ONE_DAY);
    }
    this.setState(currentStatus);
  }

  private setState(result: RateLimiterRes): void {
    this.current = result;
    this.initPromise = undefined;
  }

  /**
   * Consume from resource cap in Redis store.
   * @param points - Number of resources consumed.
   */
  async consume(points: number): Promise<void> {
    if (!this.current) {
      this.initPromise ??= this.init();
      await this.initPromise;
    } else if (this.current.remainingPoints <= 0 && this.enabled) {
      // If user is already over the limit, just block them
      throw new OperationOutcomeError(businessRule('resource-cap', 'Resource cap exceeded'));
    }

    try {
      const result = await this.limiter.consume(this.projectKey, points);
      this.setState(result);
    } catch (err: unknown) {
      if (err instanceof Error && this.enabled) {
        throw err;
      }
      const result = err as RateLimiterRes;
      this.setState(result);
      this.logger.warn('Resource cap exceeded', {
        limit: this.limiter.points,
        total: result.consumedPoints,
        enabled: this.enabled,
      });
      if (this.enabled) {
        throw new OperationOutcomeError(businessRule('resource-cap', 'Resource cap exceeded'));
      }
    }
  }

  async created(num = 1): Promise<void> {
    return this.consume(Math.max(num, 1));
  }

  async deleted(num = 1): Promise<void> {
    if (!this.current) {
      this.initPromise ??= this.init();
      await this.initPromise;
    }

    const result = await this.limiter.reward(this.projectKey, Math.max(num, 1));
    this.setState(result);
  }
}
