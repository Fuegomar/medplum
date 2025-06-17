import express, { Express } from 'express';
import request from 'supertest';
import { initApp, shutdownApp } from '../app';
import { loadTestConfig } from '../config/loader';
import { MedplumServerConfig } from '../config/types';
import { getRedis } from '../redis';
import { createTestProject } from '../test.setup';
import { getSystemRepo } from './repo';

describe('FHIR Rate Limits', () => {
  let app: Express;
  let config: MedplumServerConfig;

  beforeAll(async () => {
    config = await loadTestConfig();
  });

  beforeEach(async () => {
    app = express();
    await initApp(app, config);
    config.defaultRateLimit = -1;
    config.redis.db = 6; // Use different temp Redis instance for these tests
  });

  afterEach(async () => {
    await getRedis().flushdb();
    expect(await shutdownApp()).toBeUndefined();
  });

  test('Blocks request that would exceed limit', async () => {
    const { accessToken } = await createTestProject({
      withAccessToken: true,
      project: {
        systemSetting: [
          { name: 'enableResourceCap', valueBoolean: true },
          { name: 'resourceCap', valueInteger: 2 },
        ],
      },
    });

    const res = await request(app)
      .post('/fhir/R4/Patient')
      .auth(accessToken, { type: 'bearer' })
      .send({ resourceType: 'Patient' });
    expect(res.status).toBe(201);

    const res2 = await request(app)
      .post('/fhir/R4/Patient')
      .auth(accessToken, { type: 'bearer' })
      .send({ resourceType: 'Patient' });
    expect(res2.status).toBe(201);

    const res3 = await request(app).get('/fhir/R4/Patient').auth(accessToken, { type: 'bearer' }).send();
    expect(res3.status).toBe(200);

    const res4 = await request(app)
      .post('/fhir/R4/Patient')
      .auth(accessToken, { type: 'bearer' })
      .send({ resourceType: 'Patient' });
    expect(res4.status).toBe(422);
  });

  test('Loads current count', async () => {
    const { accessToken, project } = await createTestProject({
      withAccessToken: true,
      project: {
        systemSetting: [
          { name: 'enableResourceCap', valueBoolean: true },
          { name: 'resourceCap', valueInteger: 2 },
        ],
      },
    });

    const systemRepo = getSystemRepo();
    await systemRepo.createResource({ resourceType: 'Patient', meta: { project: project.id } });

    const res = await request(app)
      .post('/fhir/R4/Patient')
      .auth(accessToken, { type: 'bearer' })
      .send({ resourceType: 'Patient' });
    expect(res.status).toBe(201);

    const res2 = await request(app)
      .post('/fhir/R4/Patient')
      .auth(accessToken, { type: 'bearer' })
      .send({ resourceType: 'Patient' });
    expect(res2.status).toBe(422);

    const res3 = await request(app).get('/fhir/R4/Patient').auth(accessToken, { type: 'bearer' }).send();
    expect(res3.status).toBe(200);
  });
});
