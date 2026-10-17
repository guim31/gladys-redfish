# Redfish (iDRAC, iLO)

Los servidores de rack o torre tienen un controlador de gestión (BMC) que
los vigila siempre, incluso apagados: Dell iDRAC, HPE iLO, Lenovo XClarity,
Supermicro, OpenBMC… Todos hablan **Redfish**, la API estándar de la DMTF.
Esta integración la lee: un dispositivo por servidor con su estado de
encendido, estado de salud, consumo, temperaturas, ventiladores y fuentes de
alimentación. Las escenas pueden reaccionar cuando el estado se degrada,
aparece una entrada crítica en el registro de eventos, o un servidor se
enciende o se apaga, y un widget resume sus servidores en el panel. El
control de la alimentación (encendido, apagado ordenado, reinicio) existe,
**desactivado por defecto**. Todo se queda en su red local.

**Desarrollada sin el hardware: sus comentarios son bienvenidos.** Probada
contra el servidor de maquetas Redfish oficial de la DMTF (Docker): sesiones,
lecturas de los recursos Redfish antiguos y recientes, registros de eventos,
acción de reset. Las diferencias entre fabricantes (iLO 4, iDRAC) vienen de
sus esquemas documentados. Cuéntenos cómo funciona en su servidor en
[las issues](https://github.com/guim31/gladys-redfish/issues).

## Lo que necesita

- Gladys Assistant 5.1.0 o posterior.
- Un servidor cuyo controlador tenga Redfish activado: iDRAC 8 (firmware
  2.40 o posterior) o iDRAC 9, iLO 4 (2.30 o posterior), iLO 5 o iLO 6,
  Lenovo XClarity Controller, un BMC Supermicro reciente, OpenBMC.
- El controlador accesible desde el equipo de Gladys en HTTPS (puerto 443).
- Una cuenta en el controlador. Basta una de solo lectura; el control de la
  alimentación necesita una cuenta con ese permiso (Operator en un iDRAC,
  «Virtual Power and Reset» en un iLO).
- Hasta tres controladores por instalación de la integración.

## Primeros pasos

### 1. Preparar el controlador

- Compruebe que la interfaz web del controlador se abre en un navegador
  (`https://<dirección del controlador>`).
- Redfish está activo por defecto en los firmwares recientes. En un iDRAC 8,
  compruébelo en _iDRAC Settings → Services → Redfish_.
- Si puede, cree una cuenta dedicada, de solo lectura si no quiere el
  control de la alimentación.

### 2. Configurar la integración

En la pestaña **Configuración** de la integración:

- **Dirección del controlador**: `192.168.1.30`, `idrac.lan` o
  `https://idrac.lan`. Se usa HTTPS cuando no se indica `http://`.
- **Nombre de usuario** y **Contraseña** de la cuenta del controlador.
- **Nombre** (opcional): se muestra en el nombre del dispositivo, el widget
  y los mensajes. Por defecto, el nombre de host que da el controlador; si
  no, el modelo del servidor.
- Hasta dos controladores más en las secciones siguientes.
- **Intervalo de actualización**: de 30 segundos a 5 minutos (1 minuto por
  defecto). Los registros de eventos se leen cada 5 minutos.
- **Aceptar certificados autofirmados**: la mayoría de los controladores
  tienen un certificado autofirmado. Si su navegador también avisa, marque
  esta opción. La conexión sigue cifrada, pero la identidad del controlador
  ya no se comprueba: hágalo solo en su red local.
- **Permitir el control de la alimentación**: vea
  [Control de la alimentación](#control-de-la-alimentación). Desactivado por
  defecto.
- **Idioma de los nombres**: idioma de los nombres de las funciones (fijados
  al añadir el servidor), de los textos de estado y de los resultados de
  escena.

Pulse después **Probar la conexión**: una línea por controlador, con los
servidores encontrados y la autenticación usada.

### 3. Añadir el servidor

El servidor aparece en la pestaña **Descubrir** de la integración: añádalo.
Solo los servidores añadidos reciben valores; el widget y los disparadores de
escena funcionan para todos los servidores, añadidos o no.

## El dispositivo

Un dispositivo por servidor (normalmente uno por controlador; un chasis con
varios nodos da uno por nodo). Solo se proponen las funciones que el
controlador proporciona:

| Función                               | Valor                                                                |
| ------------------------------------- | -------------------------------------------------------------------- |
| Alimentación                          | Encendido o apagado. Un interruptor si el control está permitido     |
| Estado                                | OK, Advertencia o Crítico: el estado global según el controlador     |
| Consumo                               | Vatios que consume el servidor                                       |
| Temperatura de entrada                | Aire que entra en el servidor, en °C                                 |
| Temperatura del procesador            | El procesador más caliente, en °C                                    |
| Ventiladores (rpm) / Ventiladores (%) | La velocidad media de los ventiladores, en la unidad del controlador |
| Fuentes con fallo                     | 0 cuando todo va bien                                                |

El dispositivo muestra también el Id Redfish, el número de serie y la
versión del BIOS en sus parámetros. Cuando el controlador no responde, el
dispositivo lleva la insignia «inaccesible» y el estado bajo el nombre de la
integración indica por qué.

## Panel

El widget **Servidores (Redfish)** tiene dos modos:

- **sin servidor elegido**: una línea por servidor, encendido o apagado,
  estado y consumo, en naranja o rojo cuando algo va mal;
- **con un servidor elegido**: su consumo y sus temperaturas de entrada y
  del procesador en mosaicos, luego su alimentación, estado, ventiladores y
  fuentes. Cuando el control está permitido, aparecen los botones
  **Apagar** y **Reiniciar** (servidor encendido) o **Encender** (servidor
  apagado), cada uno con una confirmación.

**Actualizar** vuelve a leer los controladores.

## Escenas

### Disparadores

- **Estado del servidor degradado**: el estado pasa de OK a Advertencia o
  Crítico, o de Advertencia a Crítico. Variables: servidor, estado.
- **Nueva entrada crítica del registro**: una nueva entrada crítica en el
  registro de eventos (SEL en un iDRAC, IEL e IML en un iLO, EventLog en
  OpenBMC). Se lee cada 5 minutos; tres como máximo por lectura. Variables:
  servidor, mensaje, fecha.
- **Servidor encendido** y **Servidor apagado**: sea cual sea la causa
  (botón, controlador, corte de corriente). Variable: servidor.

Cada disparador puede limitarse a un servidor. La primera lectura tras la
instalación solo registra los estados: no se avisa de una entrada o un
estado que ya existían.

### Acciones

- **Estado de un servidor**: lee un servidor y da a las acciones siguientes
  su nombre, si el controlador responde, el encendido, el estado, el
  consumo, las temperaturas, la velocidad de los ventiladores, las fuentes
  con fallo y un resumen listo para enviar («web483: encendido, estado OK,
  344 W, entrada 25 °C…»).
- **Orden de alimentación**: encendido, apagado ordenado, reinicio o
  reinicio forzado (reset) de un servidor. Necesita **Permitir el control de
  la alimentación**.

### Ideas de escenas

- Cuando el estado del servidor NAS se degrade, enviar su estado por
  Telegram con **Estado de un servidor**.
- A la 1 de la madrugada, si no hay nadie en casa, **Orden de alimentación**
  «Apagado ordenado» en el servidor de pruebas; a las 7, «Encender».
- Cuando aparezca una **Nueva entrada crítica del registro**, avisar con su
  mensaje.

## Control de la alimentación

Desactivado por defecto. Una vez marcado **Permitir el control de la
alimentación**, pulse **Actualizar** en el servidor en la pestaña Descubrir:
la función **Alimentación** se convierte en un interruptor.

- Encender envía `On` (o una pulsación corta del botón de encendido cuando
  el controlador no ofrece `On`).
- Apagar envía un **apagado ordenado** (`GracefulShutdown`, o una pulsación
  corta en un iLO 4: el sistema operativo se apaga de forma ordenada).
  **Nunca un apagado forzado**: un interruptor accionado por error, un
  asistente de voz o una escena no deben cortar un servidor.
- **Reiniciar** (widget, escena) es un reinicio ordenado, cuando el
  controlador lo ofrece. El reinicio forzado (reset) solo existe en la acción
  de escena **Orden de alimentación**, elegido de forma explícita.

El servidor tarda en cambiar de estado: se vuelve a leer 15 segundos después
de la orden, y luego en el intervalo habitual.

## Solución de problemas

- **«certificado rechazado»**: marque **Aceptar certificados autofirmados**,
  o instale en el controlador un certificado reconocido.
- **«nombre de usuario o contraseña rechazados»**: compruebe la cuenta en la
  interfaz web del controlador. Algunos controladores bloquean una cuenta
  tras varios fallos.
- **«no responde»**: compruebe la dirección y que el puerto 443 del
  controlador es accesible desde el equipo de Gladys (¿otra VLAN?).
- **«no hay ningún servicio Redfish en esta dirección»**: Redfish está
  desactivado, o la dirección no es la del controlador (los iDRAC 7 y
  anteriores no tienen Redfish).
- **Falta una función**: el controlador no la proporciona (algunos
  ventiladores o fuentes solo se ven con el servidor encendido).
- **Una orden rechazada**: la cuenta no tiene el permiso, o el controlador
  no la ofrece (un iLO 4 no tiene reinicio ordenado).

## Límites

- Desarrollada sin el hardware: las diferencias entre fabricantes se tratan
  según sus esquemas y las maquetas oficiales, todavía no según servidores
  reales.
- Un chasis por servidor: el primero vinculado al sistema. Los chasis de
  blades y los sistemas multichasis solo muestran ese.
- El registro de eventos se lee por páginas: en un registro muy largo, puede
  perderse una entrada entre la primera y la última página.
- El controlador es un chip pequeño: un intervalo inferior a un minuto lo
  carga, y algunos firmwares registran cada sesión.
- Los controladores solo IPMI (sin Redfish) no son compatibles.

## Créditos

Las fixtures de prueba proceden de las maquetas públicas del
[DMTF Redfish Mockup Server](https://github.com/DMTF/Redfish-Mockup-Server)
(BSD 3-Clause). Redfish es una marca de la DMTF. Esta integración no está
afiliada a Dell, HPE, Lenovo, Supermicro ni a la DMTF.
