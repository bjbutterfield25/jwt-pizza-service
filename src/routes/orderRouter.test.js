const request = require('supertest');
const app = require('../service');
const { DB, Role } = require('../database/database.js');

const diner = {
  name: 'order test diner',
  email: `order-diner-${Date.now()}@test.com`,
  password: 'test-password',
};
const admin = {
  name: 'order test admin',
  email: `order-admin-${Date.now()}@test.com`,
  password: 'test-password',
  roles: [{ role: Role.Admin }],
};
const menuItem = {
  title: `Order test pizza ${Date.now()}`,
  description: 'A test pizza',
  image: '',
  price: 0.05,
};

let dinerToken;
let adminToken;
let menuItemId;

beforeAll(async () => {
  const dinerRes = await request(app).post('/api/auth').send(diner);
  dinerToken = dinerRes.body.token;

  await DB.addUser(admin);
  const adminRes = await request(app).put('/api/auth').send({ email: admin.email, password: admin.password });
  adminToken = adminRes.body.token;

  const menuRes = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(menuItem);
  const createdMenuItem = menuRes.body.find((item) => item.title === menuItem.title);
  menuItemId = createdMenuItem.id;
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('GET /api/order/menu returns the menu without authentication', async () => {
  const res = await request(app).get('/api/order/menu');

  expect(res.status).toBe(200);
  expect(res.body).toEqual(expect.arrayContaining([expect.objectContaining(menuItem)]));
});

test('PUT /api/order/menu rejects unauthenticated and non-admin users', async () => {
  const unauthenticatedRes = await request(app).put('/api/order/menu').send(menuItem);
  expect(unauthenticatedRes.status).toBe(401);

  const dinerRes = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${dinerToken}`)
    .send(menuItem);
  expect(dinerRes.status).toBe(403);
  expect(dinerRes.body.message).toBe('unable to add menu item');
});

test('GET /api/order returns the authenticated diner orders', async () => {
  const res = await request(app)
    .get('/api/order?page=1')
    .set('Authorization', `Bearer ${dinerToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ dinerId: expect.any(Number), orders: expect.any(Array), page: '1' });
});

test('GET /api/order rejects requests without authentication', async () => {
  const res = await request(app).get('/api/order');

  expect(res.status).toBe(401);
  expect(res.body.message).toBe('unauthorized');
});

test('POST /api/order creates an order and returns the factory result', async () => {
  const reportUrl = 'https://factory.test/report/123';
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ reportUrl, jwt: 'factory-jwt' }),
  });
  const orderRequest = {
    franchiseId: 1,
    storeId: 1,
    items: [{ menuId: menuItemId, description: menuItem.title, price: menuItem.price }],
  };

  const res = await request(app)
    .post('/api/order')
    .set('Authorization', `Bearer ${dinerToken}`)
    .send(orderRequest);

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    order: { ...orderRequest, id: expect.any(Number) },
    followLinkToEndChaos: reportUrl,
    jwt: 'factory-jwt',
  });
  expect(global.fetch).toHaveBeenCalledWith(
    expect.stringMatching(/\/api\/order$/),
    expect.objectContaining({ method: 'POST' }),
  );
});

test('POST /api/order rejects requests without authentication', async () => {
  const res = await request(app).post('/api/order').send({});

  expect(res.status).toBe(401);
  expect(res.body.message).toBe('unauthorized');
});

test('POST /api/order reports a factory fulfillment failure', async () => {
  const reportUrl = 'https://factory.test/report/failure';
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: false,
    json: async () => ({ reportUrl }),
  });

  const res = await request(app)
    .post('/api/order')
    .set('Authorization', `Bearer ${dinerToken}`)
    .send({
      franchiseId: 1,
      storeId: 1,
      items: [{ menuId: menuItemId, description: menuItem.title, price: menuItem.price }],
    });

  expect(res.status).toBe(500);
  expect(res.body).toEqual({
    message: 'Failed to fulfill order at factory',
    followLinkToEndChaos: reportUrl,
  });
});