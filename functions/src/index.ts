// functions/src/index.ts
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as express from 'express';
import cors = require('cors');
import { businessRoutes } from './businesses';
import { paymentRoutes } from './payments';
import { seoRoutes } from './seo';
import { notificationRoutes } from './notifications';

admin.initializeApp();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Mount routes
app.use('/businesses', businessRoutes);
app.use('/payments', paymentRoutes);
app.use('/seo', seoRoutes);
app.use('/notifications', notificationRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    paymentProvider: 'intasend'
  });
});

export const api = functions.https.onRequest(app);

// Scheduled functions for passive maintenance
export const cleanupExpiredListings = functions.pubsub
  .schedule('every 24 hours')
  .onRun(async (context) => {
    const db = admin.firestore();
    const now = admin.firestore.Timestamp.now();
    
    // Downgrade expired premium listings
    const expired = await db.collection('businesses')
      .where('subscription.status', '==', 'active')
      .where('subscription.expiresAt', '<=', now)
      .get();
    
    const batch = db.batch();
    expired.docs.forEach(doc => {
      batch.update(doc.ref, {
        'subscription.status': 'expired',
        'isFeatured': false,
        'updatedAt': now
      });
    });
    
        await batch.commit();
    console.log(`Downgraded ${expired.size} expired listings`);
  });
