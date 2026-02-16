interface PaystackPopup {
  setup(options: {
    key: string;
    email: string;
    amount: number;
    ref?: string;
    currency?: string;
    metadata?: Record<string, unknown>;
    callback: (response: { reference: string; status: string; trans: string; transaction: string }) => void;
    onClose: () => void;
  }): { openIframe: () => void };
}

interface Window {
  PaystackPop: PaystackPopup;
}
