// functions/src/seo.ts
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Router } from 'express';

const router = Router();
const db = admin.firestore();

// Generate dynamic SEO content for business
router.get('/business/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const business = await db.collection('businesses').doc(id).get();
    
    if (!business.exists) {
      return res.status(404).send('Not found');
    }
    
    const data = business.data();
    
    if (!data || !data.seo) {
      return res.status(404).send('Business data not found');
    }
    
    // Generate rich HTML with Schema.org markup
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${data.seo.title || data.name}</title>
    <meta name="description" content="${data.seo.description || ''}">
    <meta name="keywords" content="${(data.seo.keywords || []).join(', ')}">
    
    <!-- Open Graph -->
    <meta property="og:title" content="${data.name}">
    <meta property="og:description" content="${data.description?.substring(0, 200) || ''}">
    <meta property="og:type" content="business.business">
    <meta property="og:url" content="https://findbiz.co.ke/business/${id}">
    ${data.images?.logo ? `<meta property="og:image" content="${data.images.logo}">` : ''}
    
    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${data.name}">
    <meta name="twitter:description" content="${data.description?.substring(0, 200) || ''}">
    
    <!-- Schema.org JSON-LD -->
    <script type="application/ld+json">
${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "name": data.name,
  "description": data.description,
  "image": data.images?.logo || data.images?.cover || '',
  "url": `https://findbiz.co.ke/business/${id}`,
  "telephone": data.contact?.phone || '',
  "email": data.contact?.email || '',
  "address": {
    "@type": "PostalAddress",
    "streetAddress": data.location?.address || '',
    "addressLocality": data.location?.city || '',
    "addressCountry": "KE"
  },
  "geo": data.location?.coordinates ? {
    "latitude": data.location.coordinates.latitude,
    "longitude": data.location.coordinates.longitude
  } : undefined,
  "aggregateRating": data.rating && data.rating > 0 ? {
    "ratingValue": data.rating,
    "reviewCount": data.reviewCount || 0
  } : undefined,
  "priceRange": "$$",
  "openingHours": "Mo-Sa 08:00-18:00"
}, null, 2)}
    </script>
    
    <link rel="canonical" href="https://findbiz.co.ke/business/${id}">
    <style>
        body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
        .business-header { margin-bottom: 2rem; }
        .business-name { font-size: 2rem; margin-bottom: 0.5rem; }
        .business-meta { color: #666; margin-bottom: 1rem; }
        .contact-info { background: #f5f5f5; padding: 1rem; border-radius: 8px; margin: 1rem 0; }
        .btn { display: inline-block; padding: 0.75rem 1.5rem; background: #2E7D32; color: white; 
               text-decoration: none; border-radius: 6px; margin: 0.5rem 0.5rem 0 0; }
        .rating { color: #FFC107; font-size: 1.25rem; }
    </style>
</head>
<body>
    <article class="business-header">
        <h1 class="business-name">${data.name}</h1>
        <div class="business-meta">
            ${data.isVerified ? '✓ Verified Business • ' : ''}
            ${data.category} • ${data.location?.city || ''}
        </div>
        ${data.rating && data.rating > 0 ? `
        <div class="rating">
            ${'★'.repeat(Math.round(data.rating))}${'☆'.repeat(5-Math.round(data.rating))}
            <span style="color: #666; font-size: 1rem;">(${data.reviewCount || 0} reviews)</span>
        </div>
        ` : ''}
    </article>
    
    <p>${data.description}</p>
    
    <div class="contact-info">
        <h3>Contact Information</h3>
        <p>📍 ${data.location?.address || ''}, ${data.location?.city || ''}</p>
        <p>📞 <a href="tel:${data.contact?.phone || ''}">${data.contact?.phone || ''}</a></p>
        ${data.contact?.email ? `<p>✉️ <a href="mailto:${data.contact.email}">${data.contact.email}</a></p>` : ''}
        ${data.contact?.website ? `<p>🌐 <a href="${data.contact.website}" target="_blank">${data.contact.website}</a></p>` : ''}
    </div>
    
    <div>
        <a href="tel:${data.contact?.phone || ''}" class="btn">Call Now</a>
        <a href="https://wa.me/${data.contact?.whatsapp || data.contact?.phone?.replace(/\D/g, '')}" class="btn">WhatsApp</a>
        <a href="/" class="btn" style="background: #666;">Browse More Businesses</a>
    </div>
    
    <footer style="margin-top: 3rem; padding-top: 2rem; border-top: 1px solid #eee; color: #999; font-size: 0.875rem;">
        <p>Listed on FindBiz Kenya - Discover trusted local businesses</p>
    </footer>
</body>
</html>`;

    res.set('Content-Type', 'text/html');
    res.send(html);
    
  } catch (error) {
    console.error('SEO generation error:', error);
    res.status(500).send('Error generating page');
  }
});

// Generate city/category landing pages
router.get('/landing/:type/:slug', async (req, res) => {
  try {
    const { type, slug } = req.params;
    
    let title, description, businesses;
    
    if (type === 'city') {
      const city = slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      title = `Best Businesses in ${city}, Kenya | FindBiz`;
      description = `Discover top-rated local businesses in ${city}. Restaurants, salons, mechanics, and more. Read reviews and contact directly.`;
      
      const snapshot = await db.collection('businesses')
        .where('status', '==', 'active')
        .where('location.city', '==', city)
        .orderBy('rating', 'desc')
        .limit(20)
        .get();
      
      businesses = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      
    } else {
      const category = slug.replace(/-/g, ' ');
      title = `Best ${category} in Kenya | FindBiz Directory`;
      description = `Find the best ${category.toLowerCase()} across Kenya. Compare ratings, prices, and locations.`;
      
      const snapshot = await db.collection('businesses')
        .where('status', '==', 'active')
        .where('categoryLower', '==', category.toLowerCase())
        .orderBy('isFeatured', 'desc')
        .orderBy('rating', 'desc')
        .limit(20)
        .get();
      
      businesses = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    
    const businessList = businesses.map(b => `
      <article style="margin-bottom: 2rem; padding-bottom: 2rem; border-bottom: 1px solid #eee;">
        <h2><a href="/business/${b.id}" style="color: #2E7D32; text-decoration: none;">${b.name}</a></h2>
        <p style="color: #666;">${b.category} • ${b.location?.city || ''}</p>
        <p>${b.description?.substring(0, 150) || ''}...</p>
        <div style="color: #FFC107;">${'★'.repeat(Math.round(b.rating || 0))}</div>
      </article>
    `).join('');
    
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <meta name="description" content="${description}">
    <link rel="canonical" href="https://findbiz.co.ke/${type}/${slug}">
    <style>
        body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem 1rem; line-height: 1.6; }
        h1 { color: #2E7D32; border-bottom: 3px solid #2E7D32; padding-bottom: 0.5rem; }
        .breadcrumb { color: #666; margin-bottom: 1rem; font-size: 0.875rem; }
    </style>
</head>
<body>
    <nav class="breadcrumb"><a href="/">Home</a> > ${type === 'city' ? 'Cities' : 'Categories'} > ${slug.replace(/-/g, ' ')}</nav>
    <h1>${title}</h1>
    <p style="font-size: 1.125rem; color: #444; margin-bottom: 2rem;">${description}</p>
    
    <div class="business-list">
        ${businessList || '<p>No businesses found. Be the first to <a href="/add">list your business</a>!</p>'}
    </div>
    
    <footer style="margin-top: 3rem; padding-top: 2rem; border-top: 2px solid #eee; text-align: center; color: #666;">
        <p>Browse more <a href="/cities">cities</a> or <a href="/categories">categories</a></p>
        <p>&copy; 2024 FindBiz Kenya</p>
    </footer>
</body>
</html>`;

    res.set('Content-Type', 'text/html');
    res.send(html);
    
  } catch (error) {
    console.error('Landing page error:', error);
    res.status(500).send('Error generating page');
  }
});

// Generate XML Sitemap for SEO
router.get('/sitemap.xml', async (req, res) => {
  try {
    const businessesSnapshot = await db.collection('businesses')
      .where('status', '==', 'active')
      .select('updatedAt')
      .get();
    
    const citiesSnapshot = await db.collection('businesses')
      .where('status', '==', 'active')
      .select('location.city')
      .get();
    
    const cities = new Set<string>();
    citiesSnapshot.forEach(doc => {
      const city = doc.data().location?.city;
      if (city) cities.add(city);
    });

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://findbiz.co.ke/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://findbiz.co.ke/categories</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;

    cities.forEach(city => {
      const citySlug = city.toLowerCase().replace(/\s+/g, '-');
      xml += `
  <url>
    <loc>https://findbiz.co.ke/city/${citySlug}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
    });

    businessesSnapshot.forEach(doc => {
      const lastmod = doc.data().updatedAt?.toDate().toISOString().split('T')[0] || new Date().toISOString().split('T')[0];
      xml += `
  <url>
    <loc>https://findbiz.co.ke/business/${doc.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`;
    });

    xml += '\n</urlset>';

    res.set('Content-Type', 'application/xml');
    res.send(xml);
    
  } catch (error) {
    console.error('Sitemap generation error:', error);
    res.status(500).send('Error generating sitemap');
  }
});

export { router as seoRoutes };
