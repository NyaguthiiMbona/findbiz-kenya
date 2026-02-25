// functions/src/payments.ts
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Router } from 'express';
import * as axios from 'axios';

const router = Router();
const db = admin.firestore();

// Intasend config - REPLACE WITH YOUR KEYS
const INTASEND_CONFIG = {
  baseUrl: 'https://payment.intasend.com/api/v1',
  publishableKey: functions.config().intasend?.publishablekey || 'YOUR_PUBLISHABLE_KEY_HERE',
  secretKey: functions.config().intasend?.secretkey || 'YOUR_SECRET_KEY_HERE',
  testMode: true // Set to false when going live
};

// Create payment request
router.post('/initialize', async (req, res) => {
  try {
    const { businessId, userId, email, phone, firstName, lastName, plan = 'premium' } = req.body;
    
    // Validate required fields
    if (!email || !phone) {
      return res.status(400).json({ error: 'Email and phone number are required' });
    }
    
    // Amount in KES
    const amount = plan === 'premium' ? 1500 : 3000;
    const currency = 'KES';
    
    // Create payment record
    const paymentRef = db.collection('payments').doc();
    const invoiceRef = `FBZ-${Date.now()}-${paymentRef.id.substring(0, 6)}`;
    
    await paymentRef.set({
      businessId,
      userId,
      invoiceRef,
      amount,
      currency,
      plan,
      status: 'pending',
      provider: 'intasend',
      customerEmail: email,
      customerPhone: phone,
      customerName: `${firstName} ${lastName}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Create Intasend payment
    const payload = {
      amount: amount,
      currency: currency,
      email: email,
      first_name: firstName || 'Customer',
      last_name: lastName || '',
      phone_number: phone,
      host: 'https://findbiz.co.ke',
      api_ref: invoiceRef,
      redirect_url: `https://findbiz.co.ke/?ref=${invoiceRef}`,
      comment: `FindBiz ${plan} subscription`
    };
    
    const response = await axios.default.post(
      `${INTASEND_CONFIG.baseUrl}/payment/checkout/`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${INTASEND_CONFIG.secretKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Update with Intasend tracking ID
    await paymentRef.update({
      intasendId: response.data.id,
      checkoutUrl: response.data.url
    });
    
    res.json({
      success: true,
      paymentId: paymentRef.id,
      invoiceRef: invoiceRef,
      checkoutUrl: response.data.url,
      message: 'Redirect to Intasend checkout'
    });
    
  } catch (error) {
    console.error('Intasend init error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Payment initialization failed',
      details: error.response?.data?.detail || error.message
    });
  }
});

// Webhook - Intasend sends payment updates here
router.post('/webhook', async (req, res) => {
  try {
    const event = req.body;
    console.log('Intasend webhook:', JSON.stringify(event));
    
    // Verify it's a completed payment
    if (event.state === 'COMPLETE' && event.status === 'SUCCESSFUL') {
      const invoiceRef = event.api_ref;
      const transactionId = event.invoice_id;
      const amount = event.net_amount || event.amount;
      
      // Find payment record
      const paymentQuery = await db.collection('payments')
        .where('invoiceRef', '==', invoiceRef)
        .limit(1)
        .get();
      
      if (paymentQuery.empty) {
        console.error('Payment not found:', invoiceRef);
        return res.sendStatus(200);
      }
      
      const paymentDoc = paymentQuery.docs[0];
      const paymentData = paymentDoc.data();
      
      // Update payment as completed
      await paymentDoc.ref.update({
        status: 'completed',
        transactionId: transactionId,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        rawWebhook: event,
        fees: event.charges || 0,
        netAmount: amount
      });
      
      // Activate subscription
      const expiresAt = new Date();
      if (paymentData.plan === 'annual') {
        expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      } else {
        expiresAt.setMonth(expiresAt.getMonth() + 1);
      }
      
      await db.collection('businesses').doc(paymentData.businessId).update({
        'subscription.status': 'active',
        'subscription.plan': paymentData.plan,
        'subscription.paymentId': paymentDoc.id,
        'subscription.startedAt': admin.firestore.FieldValue.serverTimestamp(),
        'subscription.expiresAt': expiresAt,
        'isFeatured': true,
        'isVerified': true,
        'updatedAt': admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Send success notification
      await db.collection('notifications').add({
        type: 'payment_success',
        userId: paymentData.userId,
        businessId: paymentData.businessId,
        amount: amount,
        plan: paymentData.plan,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      console.log(`Payment successful: ${invoiceRef}, Business: ${paymentData.businessId}`);
    }
    
    // Handle failed/cancelled payments
    if (event.state === 'FAILED' || event.status === 'FAILED') {
      const invoiceRef = event.api_ref;
      
      const paymentQuery = await db.collection('payments')
        .where('invoiceRef', '==', invoiceRef)
        .limit(1)
        .get();
      
      if (!paymentQuery.empty) {
        await paymentQuery.docs[0].ref.update({
          status: 'failed',
          failureReason: event.failed_reason || event.state,
          failedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }
    
    res.sendStatus(200);
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(200);
  }
});

// Check payment status manually
router.get('/status/:invoiceRef', async (req, res) => {
  try {
    const { invoiceRef } = req.params;
    
    const payment = await db.collection('payments')
      .where('invoiceRef', '==', invoiceRef)
      .limit(1)
      .get();
    
    if (payment.empty) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    
    res.json({
      id: payment.docs[0].id,
      ...payment.docs[0].data()
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Status check failed' });
  }
});

// Get payment history
router.get('/history/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    
    const snapshot = await db.collection('payments')
      .where('businessId', '==', businessId)
      .orderBy('createdAt', 'desc')
      .get();
    
    const payments = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    res.json({ payments });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

export { router as paymentRoutes };
