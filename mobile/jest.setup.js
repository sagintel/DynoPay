// Native modules the components touch, mocked for unit tests (jest-expo mocks the rest of the SDK).
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), notificationAsync: jest.fn(), selectionAsync: jest.fn(), ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
