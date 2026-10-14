const request = require('supertest');
const app = require('../service');

const testUser = {
  name: 'pizza diner',
  email: `reg-${Date.now()}@test.com`,
  password: 'a',
};
let authToken;
let userId;

beforeAll(async () => {
  const registerRes = await request(app).post('/api/auth').send(testUser);
  expect(registerRes.status).toBe(200);
  authToken = registerRes.body.token;
  userId = registerRes.body.user.id;
  expectValidJwt(authToken);
});

test('GET /api/user/me returns the authenticated user', async () => {
  const res = await request(app)
    .get('/api/user/me')
    .set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    id: userId,
    name: testUser.name,
    email: testUser.email,
    roles: [{ role: 'diner' }],
  });
});

test('PUT /api/user/:userId updates the authenticated user', async () => {
  const updatedEmail = `updated-email-${Date.now()}@test.com`;
  const res = await request(app)
    .put(`/api/user/${userId}`)
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      name: 'Updated User',
      email: updatedEmail,
      password: 'new-password',
    });

  expect(res.status).toBe(200);
  expectValidJwt(res.body.token);
  expect(res.body.user).toMatchObject({
    id: userId,
    name: 'Updated User',
    email: updatedEmail,
    roles: [{ role: 'diner' }],
  });
});

test('list users unauthorized', async () => {
  const listUsersRes = await request(app).get('/api/user');
  expect(listUsersRes.status).toBe(401);
});

test('list users', async () => {
  const [, userToken] = await registerUser(request(app));
  const listUsersRes = await request(app)
    .get('/api/user?limit=100')
    .set('Authorization', 'Bearer ' + userToken);

  expect(listUsersRes.status).toBe(200);
  expect(Array.isArray(listUsersRes.body.users)).toBe(true);
  expect(listUsersRes.body.users.length).toBeGreaterThan(0);
  expect(listUsersRes.body.users[0]).toEqual(expect.objectContaining({
    id: expect.any(Number),
    name: expect.any(String),
    email: expect.any(String),
    roles: expect.any(Array),
  }));
});

test('list users filters by name', async () => {
  const uniqueName = `Filter-${Date.now()}`;
  const [registeredUser, userToken] = await registerUser(request(app), uniqueName);
  const listUsersRes = await request(app)
    .get(`/api/user?name=${encodeURIComponent(uniqueName)}`)
    .set('Authorization', 'Bearer ' + userToken);

  expect(listUsersRes.status).toBe(200);
  expect(listUsersRes.body.users).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: registeredUser.id,
      name: uniqueName,
      email: registeredUser.email,
    }),
  ]));
});

async function registerUser(service, customName = 'pizza diner') {
  const testUser = {
    name: customName,
    email: `${randomName()}@test.com`,
    password: 'a',
  };
  const registerRes = await service.post('/api/auth').send(testUser);
  registerRes.body.user.password = testUser.password;

  return [registerRes.body.user, registerRes.body.token];
}

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}
