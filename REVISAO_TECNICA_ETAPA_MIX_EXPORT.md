# Trap Vani AI — etapa de exportação/mistura

## Correção aplicada

- `src/audio/studioEngine.ts`: a exportação WAV agora só carrega o kit de bateria quando o padrão contém eventos de instrumentos que serão exportados. Uma exportação apenas vocal (ou apenas com 808) deixa de depender do download dos samples de kick/snare/clap/hi-hat/etc.
- A verificação respeita o modo de monitorização, instrumentos silenciados/solo, o modo de timing exato da gravação pela boca e a opção de permitir melodias.

## Validação

- Alteração estática aplicada ao código-fonte.
- Não foi possível executar compilação TypeScript nem renderização de áudio neste ambiente; a correção ainda precisa de `npm run lint`, `npm run build` e teste de exportação no navegador.
