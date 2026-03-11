// functions/src/notifications.ts
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Router } from 'express';

const router = Router();
const db = admin.firestore();

// SendGrid or similar for email
const SENDGRID_API_KEY = functions.config().sendgrid?.key;

// SMS via Africa's Talking or Twilio
const AFRICASTALKING_API_KEY = functions.config().africastalking?.key;

// Trigger: New business submitted
export const onBusinessCreated = functions.firestore
  .document('businesses/{businessId}')
  .onCreate(async (snap, context) => {
    const business = snap.data();
    const businessId = context.params.businessId;
    
    // Send email to admin
    await sendEmail({
      to: 'admin@findbiz.co.ke',
      subject: `New Business Pending Review: ${business.name}`,
      html: `
        <h2>New Business Submission</h2>
        <p><strong>Name:</strong> ${business.name}</p>
        <p><strong>Category:</strong> ${business.category}</p>
        <p><strong>Location:</strong> ${business.location.city}</p>
        <p><strong>Phone:</strong> ${business.contact.phone}</p>
        <p><a href="https://findbiz.co.ke/admin/businesses/${businessId}">Review in Admin</a></p>
      `
    });
    
    // If email provided, send confirmation to business owner
    if (business.contact.email) {
      await sendEmail({
        to: business.contact.email,
        subject: 'Your FindBiz Listing is Pending Review',
        html: `
          <h2>Thank you for listing your business!</h2>
          <p>Hi ${business.name} team,</p>
          <p>Your business listing has been received and is pending review. This usually takes 24 hours.</p>
          <p>We'll notify you once it's live.</p>
          <br>
          <p>Best regards,<br>FindBiz Kenya Team</p>
        `
      });
    }
    
    // SMS notification if phone provided
    if (business.contact.phone) {
      await sendSMS({
        to: business.contact.phone,
        message: `FindBiz: Your listing for ${business.name} is under review. You'll receive an SMS once approved. Questions? Call 0700 000 000`
      });
    }
  });

// Trigger: Payment received
export const onPaymentSuccess = functions.firestore
  .document('payments/{paymentId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    
    if (before.status !== 'completed' && after.status === 'completed') {
      // Get business details
      const business = await db.collection('businesses').doc(after.businessId).get();
      const businessData = business.data();
      
      // Exit early if no business data
      if (!businessData) {
        console.error('Business not found:', after.businessId);
        return;
      }
      
      // Send receipt email
      if (businessData?.contact?.email) {
        await sendEmail({
          to: businessData.contact.email,
          subject: 'Payment Confirmation - FindBiz Premium',
          html: `
            <h2>Payment Received</h2>
            <p>Thank you for upgrading to FindBiz Premium!</p>
            <p><strong>Amount:</strong> KSh ${after.amount}</p>
            <p><strong>M-Pesa Receipt:</strong> ${after.mpesaReceipt}</p>
            <p><strong>Valid Until:</strong> ${after.expiresAt?.toDate().toLocaleDateString()}</p>
            <p>Your business "${businessData?.name || 'Your business'}" is now featured and will appear at the top of search results.</p>
          `
        });
      }
      
      // SMS confirmation
      await sendSMS({
        to: after.phone,
        message: `FindBiz: Payment of KSh ${after.amount} received! Your business "${businessData?.name || 'Your business'}" is now featured. Receipt: ${after.mpesaReceipt}`
      });
    }
  });

// Trigger: Subscription expiring soon (3 days)
export const subscriptionReminders = functions.pubsub
  .schedule('every 24 hours')
  .onRun(async (context) => {
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
    
    const expiring = await db.collection('businesses')
      .where('subscription.status', '==', 'active')
      .where('subscription.expiresAt', '<=', threeDaysFromNow)
      .where('subscription.expiresAt', '>', new Date())
      .get();
    
    for (const doc of expiring.docs) {
      const data = doc.data();
      
      // Send renewal reminder
      if (data?.contact?.email) {
        await sendEmail({
          to: data.contact.email,
          subject: 'Your FindBiz Subscription Expires Soon',
          html: `
            <h2>Renewal Reminder</h2>
            <p>Your premium listing for ${data.name} expires in 3 days.</p>
            <p>Renew now to keep your featured status and continue getting leads.</p>
            <a href="https://findbiz.co.ke/renew/${doc.id}" style="padding: 12px 24px; background: #2E7D32; color: white; text-decoration: none; border-radius: 4px;">Renew Now</a>
          `
        });
      }
      
      // SMS reminder
      if (data?.contact?.phone) {
        await sendSMS({
          to: data.contact.phone,
          message: `FindBiz: Your premium listing for ${data.name} expires in 3 days. Renew at findbiz.co.ke/renew to stay featured.`
        });
      }
    }
    
    console.log(`Sent ${expiring.size} renewal reminders`);
  });

// Helper functions
async function sendEmail({ to, subject, html }: { to: string; subject: string; html: string }) {
  if (!SENDGRID_API_KEY) {
    console.log('Email would be sent (no API key configured):', { to, subject });
    return;
  }
  
  // Implement SendGrid or other provider
  // await sgMail.send({ to, from: 'noreply@findbiz.co.ke', subject, html });
}

async function sendSMS({ to, message }: { to: string; message: string }) {
  if (!AFRICASTALKING_API_KEY) {
    console.log('SMS would be sent (no API key configured):', { to, message });
    return;
  }
  
  // Implement Africa's Talking
  // const credentials = { apiKey: AFRICASTALKING_API_KEY, username: 'findbiz' };
  // const AfricasTalking = require('africastalking')(credentials);
  // const sms = AfricasTalking.SMS;
  // await sms.send({ to: [to], message, from: 'FindBiz' });
}

// Manual notification trigger (for admin)
router.post('/send', async (req, res) => {
  const { businessId, type, message } = req.body;
  
  const business = await db.collection('businesses').doc(businessId).get();
  if (!business.exists) return res.status(404).json({ error: 'Business not found' });
  
  const data = business.data();
  
  if (!data || !data.contact) {
    return res.status(404).json({ error: 'Business contact data not found' });
  }
  
  if (type === 'sms') {
    await sendSMS({ to: data.contact?.phone, message });
  } else if (type === 'email') {
    await sendEmail({
      to: data.contact?.email,
      subject: 'Message from FindBiz',
      html: message
    });
  } else {
    return res.status(400).json({ error: 'Invalid notification type. Use sms or email' });
  }
  
  return res.json({ success: true });
});

export { router as notificationRoutes };
