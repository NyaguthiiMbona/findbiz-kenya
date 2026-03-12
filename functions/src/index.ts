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

export const generateSitemap = functions.pubsub
  .schedule('every week')
  .onRun(async (context) => {
    const db = admin.firestore();
    const businesses = await db.collection('businesses')
      .where('status', '==', 'active')
      .get();
    
    let sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n';
    sitemap += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    sitemap += '  <url>\n';
    sitemap += '    <loc>https://findbiz.co.ke/</loc>\n';
    sitemap += '    <changefreq>daily</changefreq>\n';
    sitemap += '    <priority>1.0</priority>\n';
    sitemap += '  </url>\n';
    
    businesses.forEach(doc => {
      const data = doc.data();
      const lastmod = data.updatedAt?.toDate?.().toISOString() || new Date().toISOString();
      sitemap += '  <url>\n';
      sitemap += `    <loc>https://findbiz.co.ke/business/${doc.id}</loc>\n';
      sitemap += `    <lastmod>${lastmod}</lastmod>\n`;
      sitemap += '    <changefreq>weekly</changefreq>\n';
      sitemap += `    <priority>${data.isFeatured ? '0.8' : '0.6'}</priority>\n`;
      sitemap += '  </url>\n';
    });
    
    sitemap += '</urlset>';
    
    const bucket = admin.storage().bucket();
    const file = bucket.file('sitemaps/businesses.xml');
    await file.save(sitemap, { contentType: 'application/xml' });
    
    console.log('Sitemap generated with', businesses.size, 'URLs');
  });
