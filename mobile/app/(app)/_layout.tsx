import React from "react";
import { Redirect, Slot } from "expo-router";
import { useAuth } from "../../lib/auth";
import LoadingScreen from "../../components/LoadingScreen";

export default function AppLayout() {
  const { session, isLoading } = useAuth();

  if (isLoading) return <LoadingScreen />;
  if (!session) return <Redirect href="/(auth)/login" />;

  return <Slot />;
}
