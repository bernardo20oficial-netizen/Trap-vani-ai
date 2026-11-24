# Revisão técnica — pacote ZIP de pistas (stems)

## Objetivo
Permitir que o artista exporte as pistas separadas de uma sessão num único ficheiro ZIP, pronto para extrair e importar num DAW como o BandLab.

## Implementação
- Criado `src/audio/zipArchive.ts`, um gerador ZIP local no navegador, sem dependência externa.
- O ZIP usa o método STORE (sem compressão). Os WAV já são dados PCM e voltar a comprimi-los raramente compensa; evitar compressão também reduz carga do processador do telemóvel.
- Os ficheiros são organizados em `TRAP_VANI_STEMS/` com nomes numerados: voz, 808, kick, snare, clap, hi-hat, open hat, percussão e melodia (quando permitida no projeto).
- Incluído `LEIA-ME.txt` com BPM, formato e instruções para manter as pistas alinhadas desde o segundo zero.
- A exportação de cada pista é sequencial, não simultânea.
- As definições escolhidas pelo artista (16/24 bits e 44,1/48 kHz) são mantidas.
- O exportador continua a respeitar o mute de cada canal. Uma pista silenciada pode, portanto, resultar num WAV silencioso.

## Proteção de memória
- Antes de iniciar, é calculado o tamanho PCM estimado a partir da duração, frequência, profundidade e número de pistas.
- A exportação em lote é bloqueada quando a estimativa ultrapassa 64 MB, com orientação para exportar individualmente ou usar WAV 16 bits / 44,1 kHz.
- O tamanho final também é verificado antes de iniciar o download.
- O gerador suporta ZIP clássico até 4 GB por arquivo e não implementa ZIP64; o limite de 64 MB do lote fica muito abaixo desse limite.

## Testes realizados
- Teste independente do gerador ZIP com dois ficheiros, incluindo subpasta e texto com acentos: `unzip -t` validou todos os ficheiros sem erros.
- Verificação TypeScript estrita isolada de `zipArchive.ts`: passou.
- Transpilação sintática dos 17 ficheiros TypeScript/TSX do projeto e `server.ts`: 0 erros sintáticos.
- Integridade do ZIP completo do projeto: verificada após empacotamento.

## Limitações ainda abertas
- Não foi possível executar `npm run build`, o type-check global do projeto ou testes reais no BandLab nesta sessão, porque as dependências do projeto não estão instaladas no ambiente. A transpilação sintática não substitui esses testes.
- O ZIP de stems foi testado com arquivos de teste, não com áudio real exportado pelo navegador nem num Redmi A3 físico.
- O limite de 64 MB é deliberadamente conservador para reduzir o risco de falta de memória em telemóveis de entrada.
