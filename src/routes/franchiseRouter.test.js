const request = require('supertest');
const app = require('../service.js');
const { DB, Role } = require('../database/database.js');

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const owner = {
  name: 'franchise test owner',
  email: `franchise-owner-${runId}@test.com`,
  password: 'test-password',
};
const outsider = {
  name: 'franchise test outsider',
  email: `franchise-outsider-${runId}@test.com`,
  password: 'test-password',
};
const admin = {
  name: 'franchise test admin',
  email: `franchise-admin-${runId}@test.com`,
  password: 'test-password',
  roles: [{ role: Role.Admin }],
};
const franchiseRequest = {
  name: `franchise-test-${runId}`,
  admins: [{ email: owner.email }],
};

let ownerToken;
let outsiderToken;
let adminToken;
let ownerId;
let outsiderId;
let franchiseId;

beforeAll(async () => {
  const ownerRes = await request(app).post('/api/auth').send(owner);
  ownerToken = ownerRes.body.token;
  ownerId = ownerRes.body.user.id;

  const outsiderRes = await request(app).post('/api/auth').send(outsider);
  outsiderToken = outsiderRes.body.token;
  outsiderId = outsiderRes.body.user.id;

  await DB.addUser(admin);
  const adminRes = await request(app)
    .put('/api/auth')
    .send({ email: admin.email, password: admin.password });
  adminToken = adminRes.body.token;

  const franchiseRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(franchiseRequest);
  franchiseId = franchiseRes.body.id;
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('GET /api/franchise lists franchises without authentication', async () => {
  const res = await request(app).get('/api/franchise?page=0&limit=10');

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ franchises: expect.any(Array), more: expect.any(Boolean) });
});

test('GET /api/franchise/:userId requires authentication and limits results to the user', async () => {
  const unauthenticatedRes = await request(app).get(`/api/franchise/${ownerId}`);
  expect(unauthenticatedRes.status).toBe(401);

  const otherUserRes = await request(app)
    .get(`/api/franchise/${ownerId}`)
    .set('Authorization', `Bearer ${outsiderToken}`);
  expect(otherUserRes.status).toBe(200);
  expect(otherUserRes.body).toEqual([]);
});

test('POST /api/franchise rejects non-admin callers and creates a franchise for an admin', async () => {
  const newFranchiseRequest = {
    ...franchiseRequest,
    name: `${franchiseRequest.name}-created`,
  };
  const unauthenticatedRes = await request(app).post('/api/franchise').send(franchiseRequest);
  expect(unauthenticatedRes.status).toBe(401);

  const dinerRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(newFranchiseRequest);
  expect(dinerRes.status).toBe(403);
  expect(dinerRes.body.message).toBe('unable to create a franchise');

  const adminRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(newFranchiseRequest);

  expect(adminRes.status).toBe(200);
  expect(adminRes.body).toMatchObject({
    id: expect.any(Number),
    name: newFranchiseRequest.name,
    admins: [{ email: owner.email, id: ownerId, name: owner.name }],
  });
});

test('GET /api/franchise/:userId returns the owner franchises and hides them from other users', async () => {
  const ownerRes = await request(app)
    .get(`/api/franchise/${ownerId}`)
    .set('Authorization', `Bearer ${ownerToken}`);
  expect(ownerRes.status).toBe(200);
  expect(ownerRes.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: franchiseId, name: franchiseRequest.name })]));

  const outsiderRes = await request(app)
    .get(`/api/franchise/${ownerId}`)
    .set('Authorization', `Bearer ${outsiderToken}`);
  expect(outsiderRes.status).toBe(200);
  expect(outsiderRes.body).toEqual([]);
});

test('POST /api/franchise/:franchiseId/store enforces franchise ownership', async () => {
  const storeRequest = { name: `store-test-${runId}` };

  const unauthenticatedRes = await request(app)
    .post(`/api/franchise/${franchiseId}/store`)
    .send(storeRequest);
  expect(unauthenticatedRes.status).toBe(401);

  const outsiderRes = await request(app)
    .post(`/api/franchise/${franchiseId}/store`)
    .set('Authorization', `Bearer ${outsiderToken}`)
    .send(storeRequest);
  expect(outsiderRes.status).toBe(403);
  expect(outsiderRes.body.message).toBe('unable to create a store');

  const ownerRes = await request(app)
    .post(`/api/franchise/${franchiseId}/store`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(storeRequest);
  expect(ownerRes.status).toBe(200);
  expect(ownerRes.body).toMatchObject({
    id: expect.any(Number),
    franchiseId,
    name: storeRequest.name,
  });
});

test('DELETE /api/franchise/:franchiseId/store rejects unauthorized callers and deletes for the owner', async () => {
  const storesRes = await request(app)
    .post(`/api/franchise/${franchiseId}/store`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ name: `store-delete-test-${runId}` });
  expect(storesRes.status).toBe(200);
  const storeId = storesRes.body.id;

  const unauthenticatedRes = await request(app)
    .delete(`/api/franchise/${franchiseId}/store/${storeId}`);
  expect(unauthenticatedRes.status).toBe(401);

  const outsiderRes = await request(app)
    .delete(`/api/franchise/${franchiseId}/store/${storeId}`)
    .set('Authorization', `Bearer ${outsiderToken}`);
  expect(outsiderRes.status).toBe(403);

  jest.spyOn(DB, 'deleteStore').mockRejectedValueOnce(new Error('store deletion failed'));
  const failedDeleteRes = await request(app)
    .delete(`/api/franchise/${franchiseId}/store/${storeId}`)
    .set('Authorization', `Bearer ${ownerToken}`);
  expect(failedDeleteRes.status).toBe(500);

  const ownerRes = await request(app)
    .delete(`/api/franchise/${franchiseId}/store/${storeId}`)
    .set('Authorization', `Bearer ${ownerToken}`);
  expect(ownerRes.status).toBe(200);
  expect(ownerRes.body).toEqual({ message: 'store deleted' });
});

test('DELETE /api/franchise/:franchiseId returns an error when deletion fails', async () => {
  jest.spyOn(DB, 'deleteFranchise').mockRejectedValueOnce(new Error('franchise deletion failed'));
  const failedDeleteRes = await request(app).delete(`/api/franchise/${franchiseId}`);
  expect(failedDeleteRes.status).toBe(500);

  const res = await request(app).delete(`/api/franchise/${franchiseId}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'franchise deleted' });
});

test('GET /api/franchise/:userId rejects invalid authentication', async () => {
  const res = await request(app)
    .get(`/api/franchise/${outsiderId}`)
    .set('Authorization', 'Bearer invalid-token');

  expect(res.status).toBe(401);
});