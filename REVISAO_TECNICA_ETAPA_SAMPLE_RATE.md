# Revisão técnica — exportação WAV 44,1/48 kHz

Data: 2026-11-22

## Alterações

- `src/audio/studioEngine.ts`: `exportToWav` aceita `sampleRate` com valores permitidos de 44.100 ou 48.000 Hz. O `OfflineAudioContext` é criado diretamente na frequência escolhida, portanto o render é produzido nessa taxa (não é apenas alterado o cabeçalho WAV).
- `src/components/MixerAndExportPanel.tsx`: adicionado seletor de 44,1 kHz / 48 kHz e envio da opção ao callback de exportação.
- `src/App.tsx`: encaminha a frequência escolhida ao motor e inclui a frequência no nome do WAV exportado.
- A profundidade de 16/24 bits permanece selecionável.

## Verificações realizadas

- Transpilação sintática de 16 ficheiros TypeScript/TSX: 0 erros.
- Inspeção do fluxo: a frequência selecionada é usada na criação do `OfflineAudioContext`; o cabeçalho WAV é gerado a partir de `AudioBuffer.sampleRate`, logo os metadados acompanham a taxa real do render.
- Integridade do ZIP: verificada após empacotamento.

## Limitações

- `node_modules` não está instalado neste ambiente; não foi possível executar `vite build` nem `tsc --noEmit` com as dependências do projeto.
- Não foram realizados testes de renderização num navegador nem audição em dispositivos reais.
- 48 kHz não cria informação sonora adicional a partir de fontes de 44,1 kHz; oferece apenas um formato de entrega útil em determinados fluxos de vídeo/produção.
