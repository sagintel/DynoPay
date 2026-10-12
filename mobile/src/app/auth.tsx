import { Redirect } from 'expo-router';

/** Landing route for the PayPal sign-in deep link (the auth session already consumed the code). */
export default function AuthRedirect() {
  return <Redirect href="/" />;
}
