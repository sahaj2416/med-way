const express = require('express');
const { getAsync } = require('../db/database');
const { verifyPassword, createToken } = require('../utils/auth');
const { authenticateToken } = require('../middleware/auth');
const { createRateLimiter } = require('../utils/rateLimiter');

const router = express.Router();

const loginRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: 20,
  message: 'Too many login attempts. Please wait 5 minutes before trying again.'
});

router.post('/login', loginRateLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email and password are required' });
  }

  try {
    const user = await getAsync(
      'SELECT id, name, email, role, password_hash FROM users WHERE LOWER(email) = LOWER(?)',
      [email.trim()]
    );

    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const token = createToken({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/me', authenticateToken, (req, res) => {
  res.json({
    success: true,
    user: req.user
  });
});

module.exports = router;
