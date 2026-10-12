import { Redirect } from 'expo-router';

/** Landing route for the PayPal top-up return deep link; the confirmation flow captures the payment. */
export default function TopUpRedirect() {
  return <Redirect href="/" />;
}
