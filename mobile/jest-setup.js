// Global jest setup.
//
// Mock AsyncStorage with the library's own in-memory implementation so any module
// that reads/writes it directly (lib/auth.tsx single-session, the login screen's
// remembered email) works under jest instead of hitting a null native module.
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
