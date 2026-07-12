import { Redirect } from "expo-router";
import { useAuth } from "../lib/auth";

export default function Index() {
  const { session, isLoading } = useAuth();

  if (isLoading) return null;
  return <Redirect href={session ? "/(app)" : "/(auth)/login"} />;
}
