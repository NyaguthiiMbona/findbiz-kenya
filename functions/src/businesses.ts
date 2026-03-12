// functions/src/businesses.ts
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Router } from 'express';
import algoliasearch from 'algoliasearch';

const router = Router();
const db = admin.firestore();

// Initialize Algolia for search (free tier: 10k records)
const algoliaClient = algoliasearch(
  functions.config().algolia.appid,
  functions.config().algolia.apikey
);
const index = algoliaClient.initIndex('businesses');

// CREATE Business
router.post('/', async (req, res) => {
  try {
    const { name, category, location, contact, description, ownerId } = req.body;
    
    // Validation
    if (!name || !category || !location || !contact?.phone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Check for duplicates
    const existing = await db.collection('businesses')
      .where('contact.phone', '==', contact.phone)
      .where('status', 'in', ['active', 'pending'])
      .limit(1)
      .get();
    
    if (!existing.empty) {
      return res.status(409).json({ 
        error: 'Business with this phone already exists',
        existingId: existing.docs[0].id
      });
    }
    
    const businessData = {
      name: name.trim(),
      nameLower: name.toLowerCase(), // For case-insensitive search
      category,
      categoryLower: category.toLowerCase(),
      location: {
        city: location.city,
        area: location.area || '',
        address: location.address || '',
        coordinates: location.coordinates || null // GeoPoint
      },
      contact: {
        phone: contact.phone,
        email: contact.email || '',
        website: contact.website || '',
        whatsapp: contact.whatsapp || ''
      },
      description: description || '',
      images: {
        logo: '',
        cover: '',
        gallery: []
      },
      rating: 0,
      reviewCount: 0,
      status: 'pending', // Requires approval
      isFeatured: false,
      isVerified: false,
      ownerId: ownerId || null,
      subscription: {
        status: 'free',
        plan: 'basic',
        startedAt: null,
        expiresAt: null
      },
      seo: {
        title: `${name} - ${category} in ${location.city}`,
        description: description?.substring(0, 160) || '',
        keywords: [category, location.city, 'Kenya', 'business']
      },
      stats: {
        views: 0,
        clicks: 0,
        calls: 0
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    const docRef = await db.collection('businesses').add(businessData);
    
    // Add to Algolia for search
    await index.saveObject({
      objectID: docRef.id,
      ...businessData,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    // Send notification to admin
    await db.collection('notifications').add({
      type: 'new_listing',
      businessId: docRef.id,
      businessName: name,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.status(201).json({
      id: docRef.id,
      ...businessData,
      message: 'Business submitted for review. We will contact you within 24 hours.'
    });
    
  } catch (error) {
    console.error('Error creating business:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// READ Business (with caching)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Track view (async, don't wait)
    db.collection('businesses').doc(id).collection('analytics').add({
      type: 'view',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      userAgent: req.headers['user-agent'],
      ip: req.ip
    }).catch(console.error);
    
    const doc = await db.collection('businesses').doc(id).get();
    
    if (!doc.exists) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    const data = doc.data();
    
    // Increment view counter (batched for performance)
    db.collection('businesses').doc(id).update({
      'stats.views': admin.firestore.FieldValue.increment(1)
    }).catch(console.error);
    
    res.json({ id: doc.id, ...data });
    
  } catch (error) {
    console.error('Error fetching business:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// SEARCH Businesses (with filters)
router.get('/', async (req, res) => {
  try {
    const {
      q, // search query
      category,
      city,
      featured,
      verified,
      page = '1',
      limit = '20',
      sortBy = 'relevance' // relevance, rating, newest, distance
    } = req.query;
    
    const pageNum = parseInt(page as string);
    const limitNum = Math.min(parseInt(limit as string), 50);
    
    // Use Algolia for text search, Firestore for filters
    if (q && typeof q === 'string' && q.length > 0) {
      const searchParams: any = {
        hitsPerPage: limitNum,
        page: pageNum - 1,
        filters: 'status:active'
      };
      
      if (category) searchParams.filters += ` AND category:${category}`;
      if (city) searchParams.filters += ` AND location.city:${city}`;
      if (featured === 'true') searchParams.filters += ` AND isFeatured:true`;
      if (verified === 'true') searchParams.filters += ` AND isVerified:true`;
      
      const { hits, nbHits, nbPages } = await index.search(q, searchParams);
      
      return res.json({
        businesses: hits,
        pagination: {
          total: nbHits,
          pages: nbPages,
          current: pageNum,
          hasMore: pageNum < nbPages
        }
      });
    }
    
    // Firestore query for browse (no text search)
    let query: any = db.collection('businesses')
      .where('status', '==', 'active')
      .orderBy('isFeatured', 'desc')
      .orderBy('rating', 'desc');
    
    if (category) {
      query = query.where('category', '==', category);
    }
    
    if (city) {
      query = query.where('location.city', '==', city);
    }
    
    if (featured === 'true') {
      query = query.where('isFeatured', '==', true);
    }
    
    const snapshot = await query
      .limit(limitNum)
      .offset((pageNum - 1) * limitNum)
      .get();
    
    const businesses = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    // Get total count (approximate for performance)
    const countSnapshot = await db.collection('businesses')
      .where('status', '==', 'active')
      .count().get();
    
    res.json({
      businesses,
      pagination: {
        total: countSnapshot.data().count,
        pages: Math.ceil(countSnapshot.data().count / limitNum),
        current: pageNum,
        hasMore: businesses.length === limitNum
      }
    });
    
  } catch (error) {
    console.error('Error searching businesses:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// UPDATE Business
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // Remove protected fields
    delete updates.status;
    delete updates.isVerified;
    delete updates.createdAt;
    delete updates.stats;
    
    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    
    await db.collection('businesses').doc(id).update(updates);
    
    // Sync to Algolia
    await index.partialUpdateObject({
      objectID: id,
      ...updates
    });
    
    res.json({ success: true, message: 'Business updated' });
    
  } catch (error) {
    console.error('Error updating business:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// CLAIM Business
router.post('/:id/claim', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, registrationNumber, idDocument } = req.body;
    
    const businessRef = db.collection('businesses').doc(id);
    const business = await businessRef.get();
    
    if (!business.exists) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (business.data().ownerId) {
      return res.status(409).json({ error: 'Business already claimed' });
    }
    
    // Create claim request
    await db.collection('claims').add({
      businessId: id,
      userId,
      status: 'pending',
      registrationNumber,
      idDocument, // URL to stored image
      submittedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Notify admin
    await db.collection('notifications').add({
      type: 'claim_request',
      businessId: id,
      businessName: business.data().name,
      userId,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ 
      success: true, 
      message: 'Claim submitted. Verification takes 1-2 business days.' 
    });
    
  } catch (error) {
    console.error('Error claiming business:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Track interactions (call, direction, etc.)
router.post('/:id/track', async (req, res) => {
  try {
    const { id } = req.params;
    const { type } = req.body; // 'call', 'direction', 'website', 'whatsapp'
    
    const field = `stats.${type}s`;
    
    await db.collection('businesses').doc(id).update({
      [field]: admin.firestore.FieldValue.increment(1)
    });
    
    // Log for analytics
    await db.collection('businesses').doc(id).collection('interactions').add({
      type,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ip: req.ip
    });
    
    res.json({ success: true });
    
  } catch (error) {
    res.status(500).json({ error: 'Tracking failed' });
  }
});

export { router as businessRoutes };
