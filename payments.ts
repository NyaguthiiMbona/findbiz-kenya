// functions/src/payments.ts
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Router } from 'express';
import * as axios from 'axios';
import * as crypto from 'crypto';

const router = Router();
const db = admin.firestore();

// M-Pesa Daraja API config
const MPESA_CONFIG = {
  baseUrl: 'https://sandbox.safaricom.co.ke', // Change to live for production
  consumerKey: functions.config().mpesa.consumerkey,
  consumerSecret: functions.config().mpesa.consumersecret,
  passkey: functions.config().mpesa.passkey,
  shortcode: '174379', // Test shortcode
  callbackUrl: 'https://us-central1-findbiz-kenya.cloudfunctions.net/api/payments/callback'
};

// Get M-Pesa access token
async function getAccessToken(): Promise<string> {
  const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
  
  const response = await axios.default.get(
    `${MPESA_CONFIG.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${auth}` }
    }
  );
  
  return response.data.access_token;
}

// Initiate STK Push (Paybill)
router.post('/stkpush', async (req, res) => {
  try {
    const { phone, amount, businessId, userId, plan = 'premium' } = req.body;
    
    // Validate phone ( Kenyan format)
    const cleanPhone = phone.replace(/\D/g, '');
    const formattedPhone = cleanPhone.startsWith('0') 
      ? '254' + cleanPhone.substring(1) 
      : cleanPhone;
    
    if (!formattedPhone.match(/^2547\d{8}$/)) {
      return res.status(400).json({ error: 'Invalid phone number. Use format: 0712345678' });
    }
    
    const token = await getAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    const password = Buffer.from(
      `${MPESA_CONFIG.shortcode}${MPESA_CONFIG.passkey}${timestamp}`
    ).toString('base64');
    
    const checkoutRequestId = crypto.randomUUID();
    
    // Save pending payment
    await db.collection('payments').doc(checkoutRequestId).set({
      businessId,
      userId,
      phone: formattedPhone,
      amount: parseInt(amount),
      plan,
      status: 'pending',
      checkoutRequestId,
      merchantRequestId: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    const payload = {
      BusinessShortCode: MPESA_CONFIG.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: formattedPhone,
      PartyB: MPESA_CONFIG.shortcode,
      PhoneNumber: formattedPhone,
      CallBackURL: `${MPESA_CONFIG.callbackUrl}?id=${checkoutRequestId}`,
      AccountReference: `FindBiz-${businessId.substring(0, 8)}`,
      TransactionDesc: `Subscription: ${plan}`
    };
    
    const response = await axios.default.post(
      `${MPESA_CONFIG.baseUrl}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    
    // Update with M-Pesa request ID
    await db.collection('payments').doc(checkoutRequestId).update({
      merchantRequestId: response.data.MerchantRequestID,
      mpesaResponse: response.data
    });
    
    res.json({
      success: true,
      checkoutRequestId,
      message: 'Payment request sent. Check your phone to complete M-Pesa payment.',
      response: response.data
    });
    
  } catch (error) {
    console.error('STK Push error:', error);
    res.status(500).json({ 
      error: 'Payment initiation failed',
      details: error.message 
    });
  }
});

// M-Pesa Callback (Async)
router.post('/callback', async (req, res) => {
  try {
    const { id } = req.query;
    const callbackData = req.body.Body.stkCallback;
    
    console.log('M-Pesa Callback:', JSON.stringify(callbackData));
    
    const paymentRef = db.collection('payments').doc(id as string);
    const payment = await paymentRef.get();
    
    if (!payment.exists) {
      console.error('Payment not found:', id);
      return res.sendStatus(200); // Acknowledge receipt
    }
    
    const paymentData = payment.data();
    
    if (callbackData.ResultCode === 0) {
      // Success
      const metadata = callbackData.CallbackMetadata.Item;
      const mpesaReceipt = metadata.find((i: any) => i.Name === 'MpesaReceiptNumber')?.Value;
      const transactionDate = metadata.find((i: any) => i.Name === 'TransactionDate')?.Value;
      const phone = metadata.find((i: any) => i.Name === 'PhoneNumber')?.Value;
      
      // Update payment record
      await paymentRef.update({
        status: 'completed',
        mpesaReceipt,
        transactionDate: transactionDate?.toString(),
        phone,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        rawCallback: callbackData
      });
      
      // Activate subscription
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1); // 1 month subscription
      
      await db.collection('businesses').doc(paymentData.businessId).update({
        'subscription.status': 'active',
        'subscription.plan': paymentData.plan,
        'subscription.startedAt': admin.firestore.FieldValue.serverTimestamp(),
        'subscription.expiresAt': expiresAt,
        'subscription.paymentId': id,
        'isFeatured': true,
        'updatedAt': admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Send success notification
      await db.collection('notifications').add({
        type: 'payment_success',
        userId: paymentData.userId,
        businessId: paymentData.businessId,
        amount: paymentData.amount,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
    } else {
      // Failed
      await paymentRef.update({
        status: 'failed',
        resultCode: callbackData.ResultCode,
        resultDesc: callbackData.ResultDesc,
        failedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    res.sendStatus(200); // Must return 200 to M-Pesa
    
  } catch (error) {
    console.error('Callback processing error:', error);
    res.sendStatus(200); // Still acknowledge to prevent retries
  }
});

// Check payment status
router.get('/status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const payment = await db.collection('payments').doc(id).get();
    
    if (!payment.exists) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    
    res.json({
      id: payment.id,
      ...payment.data()
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Status check failed' });
  }
});

// Get payment history for business
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
