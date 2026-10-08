export function catalogFixture(context = 131072) {
  const model = (id: string) => ({
    id,
    name: id,
    structured_output: true,
    temperature: true,
    modalities: { input: ['text'], output: ['text'] },
    limit: { context },
  })
  return {
    mock: {
      id: 'mock',
      name: '测试 Provider',
      npm: '@ai-sdk/openai',
      api: 'https://mock.example/v1',
      env: ['MOCK_API_KEY'],
      models: Object.fromEntries(
        ['test-model', 'second-model', 'new-model', 'new-model-from-other-tab'].map((id) => [
          id,
          model(id),
        ]),
      ),
    },
  }
}
