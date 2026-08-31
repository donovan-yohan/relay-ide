// Ambient declarations for globals the test suite sets up itself.
// React's `act()` environment flag is a global the React DOM test utilities
// read; it has no ambient declaration in @types/react.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

export {};
