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

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}
