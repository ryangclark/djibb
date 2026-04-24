export const MOCK_AUTH_MODE = 'MOCK_AUTH_MODE';

const defaultFeatureFlagConfig = {
    MOCK_AUTH_MODE: true,
};

function createFlagRouter(featureConfig: Record<string, boolean>) {
    return {
        setFeature(featureName: string, isEnabled: boolean) {
            featureConfig[featureName] = isEnabled;
        },
        featureIsEnabled(featureName: string) {
            return featureConfig[featureName];
        },
    };
}

export const FlagRouter = createFlagRouter(defaultFeatureFlagConfig);
