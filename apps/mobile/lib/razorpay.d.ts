// Type declarations for react-native-razorpay (the package ships types only
// under src/, not for its main entry RazorpayCheckout.js).
declare module 'react-native-razorpay' {
  export interface RazorpayOptions {
    key: string;
    amount: number | string; // paise
    currency?: string;
    name?: string;
    description?: string;
    image?: string;
    order_id?: string;
    prefill?: { name?: string; email?: string; contact?: string };
    notes?: Record<string, string>;
    theme?: { color?: string; hide_topbar?: boolean };
    modal?: { ondismiss?: () => void; [k: string]: unknown };
    [key: string]: unknown;
  }

  export interface PaymentSuccessData {
    razorpay_payment_id: string;
    razorpay_order_id?: string;
    razorpay_signature?: string;
    [key: string]: unknown;
  }

  export interface PaymentErrorData {
    code: number;
    description: string;
    source: string;
    step: string;
    reason: string;
    metadata: { order_id?: string; payment_id?: string; [key: string]: unknown };
  }

  export default class RazorpayCheckout {
    static open(
      options: RazorpayOptions,
      success?: (data: PaymentSuccessData) => void,
      error?: (data: PaymentErrorData) => void,
    ): Promise<PaymentSuccessData>;
    static onExternalWalletSelection(cb: (data: { external_wallet: string }) => void): void;
  }
}
