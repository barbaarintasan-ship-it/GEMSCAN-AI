import { Redirect } from "expo-router";
import { useAuth } from "../lib/auth";
import LoadingScreen from "../components/LoadingScreen";

export default function Index() {
  const { session, isLoading } = useAuth();

  if (isLoading) return <LoadingScreen />;
  return <Redirect href={session ? "/(app)" : "/(auth)/login"} />;
}
