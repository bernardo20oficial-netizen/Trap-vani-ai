# Revisão técnica — compatibilidade de exportação com BandLab e outros DAWs

Data: 2026-11-22

## Referência de compatibilidade

A documentação oficial do BandLab consultada nesta revisão informa que o BandLab Web e o BandLab para Android aceitam importação de WAV. A tabela oficial de formatos também informa que o mixdown do BandLab Web é disponibilizado em WAV de 16 bits / 44,1 kHz. A documentação não especifica, nessa tabela, todas as combinações de profundidade de bits e frequência aceites na importação de WAV. Por isso, 16 bits / 44,1 kHz é apresentado na interface como a opção conservadora de interoperabilidade, não como a única combinação suportada.

Referências:
- https://help.bandlab.com/hc/en-us/articles/360036010533-Supported-Import-and-Export-File-Formats
- https://help.bandlab.com/hc/en-us/articles/900003008403-Importing-Audio-and-MIDI-Files

## Alterações implementadas

- Mantido o WAV RIFF com áudio PCM inteiro, estéreo, sem codec proprietário.
- Mantidas as opções de 16/24 bits e 44,1/48 kHz.
- Adicionada exportação de uma pista individual por operação: voz, 808, kick, snare, clap, hi-hat, open hat, percussão ou melodia.
- Cada stem é renderizado desde o segundo zero e usa a duração global da sessão, permitindo alinhar os ficheiros ao importá-los em pistas separadas de outro DAW.
- A exportação individual respeita o mute da pista escolhida, mas isola essa pista das restantes opções solo do misturador.
- Os samples de kit só são carregados quando a pista selecionada precisa deles.
- O nome dos ficheiros identifica a pista, frequência e profundidade de bits.

## Limitações e verificações pendentes

- A exportação de stems é feita individualmente; ainda não existe um pacote ZIP automático com todas as pistas.
- Não foi possível testar uma importação real numa conta BandLab nem em outros DAWs neste ambiente.
- Não foi possível executar a compilação Vite porque as dependências locais (`node_modules`) não estão instaladas.
- A validação TypeScript executada nesta etapa foi de transpilation/sintaxe, não uma verificação completa de tipos.
- Recomenda-se testar primeiro WAV estéreo PCM 16 bits / 44,1 kHz no BandLab Android; depois testar 24 bits / 48 kHz e confirmar se a aplicação de destino os aceita.

## Verificações executadas nesta etapa

- Transpilation sintática de 16 ficheiros TypeScript/TSX: sem erros.
- Inspeção estática da cadeia de exportação: `OfflineAudioContext` estéreo, WAV RIFF/PCM, campos de frequência, alinhamento e tamanho dos dados.
- Integridade do ZIP: verificada após empacotamento.
