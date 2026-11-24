# Bitácora de decisiones

Decisiones del equipo Los Estellares para la buildathon Stellar Codember Perú 2026. Una entrada por
decisión: qué se decidió, por qué y qué se descartó. Las decisiones técnicas anteriores del
proyecto están en [`HANDOFF.md`](HANDOFF.md).

| Fecha  | Decisión                                                                                  | Por qué                                                                                                                        | Alternativa descartada                                           |
| ------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 22-nov | Perú primero: soles (PEN) como moneda por defecto, textos y datos de ejemplo              | El usuario objetivo está en el Perú y la investigación de mercado muestra que no hay una rampa de Stellar operativa para soles | Mantener la configuración anterior (bolivianos por defecto)      |
| 22-nov | Yape y Plin como medio de pago propio (`pe_wallet`), antes que CCI                        | Son los medios que más usan las personas en el Perú; pagan a un número de celular                                              | Ofrecer solo transferencia por CCI                               |
| 22-nov | Diseño de la app inspirado en una wallet de stablecoins (saldo, enviar, recibir, cambiar) | Se siente como una cuenta, no como una app de trading, para quien nunca usó cripto                                             | Diseños de exchange P2P para traders                             |
| 23-nov | Licencia MIT                                                                              | Recomendada por las bases de la buildathon                                                                                     | Mantener el proyecto sin licencia                                |
| 23-nov | README en español                                                                         | El jurado y el público de la buildathon son de habla hispana                                                                   | README en inglés                                                 |
| 24-nov | «Cambista» en lugar de «comerciante» en los textos en español                             | Es como se llama en el Perú a quien cambia dinero; «merchant» se mantiene en el código y en inglés                             | «Comerciante», traducción usual de «merchant» en plataformas P2P |
| 24-nov | Campaña de lanzamiento sin comisión de protocolo para los primeros usuarios y cambistas   | Captar liquidez y usuarios en un mercado de dos lados; el ingreso inicial se sacrifica por crecimiento                         | Cobrar la comisión desde el inicio                               |
