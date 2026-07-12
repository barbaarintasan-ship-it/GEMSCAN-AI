import React from "react";
import { Redirect, Slot } from "expo-router";
import { useAuth } from "../../lib/auth";

export default function AppLayout() {
  const { session, isLoading } = useAuth();

  if (isLoading) return null;
  if (!session) return <Redirect href="/(auth)/login" />;

  return <Slot />;
}
