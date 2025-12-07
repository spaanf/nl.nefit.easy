const Homey           = require('homey');
const NefitEasyClient = require('./client');
const Capabilities    = require('./capabilities');

const DEBOUNCE_RATE = 500;
const PAIRED_WITH_APP_VERSION = 'paired_with_app_version';
const formatValue   = t => Math.round(t.toFixed(1) * 10) / 10

// Log stack for unhandled rejections.
process.on('unhandledRejection', r => {
  console.log(r.stack);
});

module.exports = class NefitEasyDevice extends Homey.Device {

  async onInit() {
    this.settings = await this.updateSettings();
    this.log(`device init: name = ${ this.getName() }, serial = ${ this.settings.serialNumber }`);

    // Capability sniffing to sniff out older SDKv1 devices.
    if (! this.hasCapability(Capabilities.OPERATING_MODE)) {
      this.log('device entry too old, needs to be re-added');
      await this.setUnavailable(this.homey.__('device.too_old'));
      return;
    }

    // Remove `thermostat_mode` capability (not used anymore since v4.0.7)
    if (this.hasCapability('thermostat_mode')) {
      await this.removeCapability('thermostat_mode').catch(e => this.error(e));
    }

    // Instantiate client for this device.
    await this.setUnavailable(this.homey.__('device.connecting'));
    try {
      this.client = await this.getClient(this.settings);
    } catch(e) {
      this.log(`unable to initialize device: ${ e.message }`);
      throw e;
    }

    // If device was paired with pre-SDKv2 version force re-pair
    const pairedWithAppVersion = this.getStoreValue(PAIRED_WITH_APP_VERSION);
    if (! pairedWithAppVersion) {
      return this.setUnavailable(this.homey.__('force_repair'));
    }

    // Register capabilities.
    this.registerCapabilities()

    // Wait for driver to get ready.
    await this.driver.ready();

    // Device is available.
    await this.setAvailable();

    // Start syncing periodically.
    this.shouldSync = true;
    this.startSyncing();
  }

  // Merge data (from pairing) with settings.
  async updateSettings() {
    let merged   = Object.assign({}, this.getData());
    let settings = this.getSettings();
    Object.keys(settings).forEach(key => {
      if (settings[key]) {
        merged[key] = settings[key];
      }
    });

    // Merge back into settings.
    await this.setSettings(merged);
    return merged;
  }

  // Register setters for capabilities.
  registerCapabilities() {
    this.registerMultipleCapabilityListener([ Capabilities.TARGET_TEMP ],     this.onSetTargetTemperature.bind(this), DEBOUNCE_RATE);
    this.registerMultipleCapabilityListener([ Capabilities.CLOCK_PROGRAMME ], this.onSetClockProgramme   .bind(this), DEBOUNCE_RATE);
    this.registerMultipleCapabilityListener([ Capabilities.FIREPLACE_MODE ],  this.onSetFireplaceMode    .bind(this), DEBOUNCE_RATE);
    this.registerMultipleCapabilityListener([ Capabilities.HOLIDAY_MODE ],    this.onSetHolidayMode      .bind(this), DEBOUNCE_RATE);
    this.registerMultipleCapabilityListener([ Capabilities.SHOWER_TIMER ],    this.onSetShowerTimer      .bind(this), DEBOUNCE_RATE);
    this.registerMultipleCapabilityListener([ Capabilities.SHOWER_TIME ],     this.onSetShowerTime       .bind(this), DEBOUNCE_RATE);
  }

  // Get a (connected) instance of the Nefit Easy client.
  async getClient(settings) {
    let client = new NefitEasyClient({
      serialNumber : settings.serialNumber,
      accessKey    : settings.accessKey,
      password     : settings.password,
    });
    await client.connect();
    this.log('device connected successfully to backend');
    return client;
  }

  // Set a capability value, optionally formatting it.
  async setValue(cap, value) {
    if (value == null) return;
    if (typeof value === 'number') {
      value = formatValue(value);
    }
    if (this.getCapabilityValue(cap) !== value) {
      await this.setCapabilityValue(cap, value).catch(e => {
        this.log(`Unable to set capability '${ cap }': ${ e.message }`);
      });
    }
  }

  // Update device status by querying the backend (which in
  // turn proxies the requests to the Nefit Easy device).
  async updateStatus() {
    let [ status, pressure, holidayStatus, timerStatus ] = await Promise.all([
      this.client.status(),
      this.client.pressure(),
      this.client.holidayMode(),
      this.client.showerTimer(),
    ]);

    // Update modes and temperatures.
    if (status) {
      // Target temperature depends on the user mode: manual or program.
      let temp = Number(status[ status['user mode'] === 'manual' ? 'temp manual setpoint' : 'temp setpoint' ])
      this.log('...updating status');
      await Promise.all([
        this.setValue(Capabilities.CLOCK_PROGRAMME, status['user mode'] === 'clock'),
        this.setValue(Capabilities.FIREPLACE_MODE,  status['fireplace mode']),
        this.setValue(Capabilities.OPERATING_MODE,  status['boiler indicator']),
        this.setValue(Capabilities.CENTRAL_HEATING, status['boiler indicator'] === 'central heating'),
        this.setValue(Capabilities.INDOOR_TEMP,     status['in house temp']),
        this.setValue(Capabilities.OUTDOOR_TEMP,    status['outdoor temp']),
        this.setValue(Capabilities.TARGET_TEMP,     temp),
      ]);
    }

    if (holidayStatus) {
      this.setValue(Capabilities.HOLIDAY_MODE, holidayStatus.value === 'on');
    }

    if (timerStatus) {
      this.setValue(Capabilities.SHOWER_TIMER, timerStatus.value === 'on');
    }

    // Update pressure.
    if (pressure && pressure.unit === 'bar' && pressure.pressure < 25) {
      this.log('...updating pressure', pressure);
      let value       = pressure.pressure;
      let alarmActive = value < this.settings.pressureTooLow || value > this.settings.pressureTooHigh;

      // If the pressure alarm should be active, but it isn't yet, trigger the flow card.
      if (alarmActive && ! this.getCapabilityValue(Capabilities.ALARM_PRESSURE)) {
        this.log(`...activating pressure alarm (lower limit = ${ this.settings.pressureTooLow }, upper limit = ${ this.settings.pressureTooHigh})`);
        this.driver._triggers[Capabilities.ALARM_PRESSURE].trigger(this, { [ Capabilities.PRESSURE ] : value });
      }

      await Promise.all([
        this.setValue(Capabilities.PRESSURE, value),
        this.setValue(Capabilities.ALARM_PRESSURE, alarmActive)
      ]);
    }
  }

  // Set target temperature on Nefit Easy device.
  async onSetTargetTemperature(data, opts) {
    let value = data[Capabilities.TARGET_TEMP];
    this.log('setting target temperature to', value);

    // Retrieve current target temperature from backend.
    let status = await this.client.status();
    let currentValue = formatValue(status[ status['user mode'] === 'manual' ? 'temp manual setpoint' : 'temp setpoint' ]);

    if (currentValue === value) {
      this.log('(value matches current, not updating)');
      // Check if capability value matches.
      if (this.getCapabilityValue(Capabilities.TARGET_TEMP) !== value) {
        await this.setValue(Capabilities.TARGET_TEMP, value);
      }
      return true;
    }

    return this.client.setTemperature(value).then(s => {
      this.log('...status:', s.status);
      if (s.status === 'ok') {
        return this.setValue(Capabilities.TARGET_TEMP, value);
      }
    });
  }

  // Enable/disable clock program.
  async onSetClockProgramme(data, opts) {
    let value = data[Capabilities.CLOCK_PROGRAMME];
    this.log('setting programme mode to', value ? 'clock' : 'manual');

    // Retrieve current status from backend.
    let status = await this.client.status();
    let currentValue = status['user mode'] === 'clock';

    if (currentValue === value) {
      this.log('(value matches current, not updating)');
      // Check if capability value matches.
      if (this.getCapabilityValue(Capabilities.CLOCK_PROGRAMME) !== value) {
        await this.setValue(Capabilities.CLOCK_PROGRAMME, value);
      }
      return true;
    }

    return this.client.setUserMode(value ? 'clock' : 'manual').then(s => {
      this.log('...status:', s.status);
      if (s.status === 'ok') {
        return this.setValue(Capabilities.CLOCK_PROGRAMME, value);
      }
    });
  }

  // Enable/disable fireplace mode.
  async onSetFireplaceMode(data, opts) {
    let value = data[Capabilities.FIREPLACE_MODE];
    this.log('setting fireplace mode to', value ? 'on' : 'off');

    // Retrieve current status from backend.
    let status = await this.client.status();
    let currentValue = status['fireplace mode'] === true;

    if (currentValue === value) {
      this.log('(value matches current, not updating)');
      return true;
    }

    return this.client.setFireplaceMode(value).then(s => {
      this.log('...status:', s.status);
      if (s.status === 'ok') {
        return this.setValue(Capabilities.FIREPLACE_MODE, value);
      }
    });
  }

  // Enable/disable holiday mode.
  async onSetHolidayMode(data, opts) {
    let value = data[Capabilities.HOLIDAY_MODE];
    this.log('setting holiday mode to', value ? 'on' : 'off');

    // Retrieve current status from backend.
    let status = await this.client.holidayMode();
    let currentValue = status.value === 'on';

    if (currentValue === value) {
      this.log('(value matches current, not updating)');
      return true;
    }

    return this.client.setHolidayMode(value).then(s => {
      this.log('...status:', s.status);
      if (s.status === 'ok') {
        return this.setValue(Capabilities.HOLIDAY_MODE, value);
      }
    });
  }

  // Enable/disable shower timer.
  async onSetShowerTimer(data, opts) {
    let value = data[Capabilities.SHOWER_TIMER];
    this.log('Setting shower timer to', value ? 'on' : 'off');

    // Retrieve current status from backend.
    let status = await this.client.showerTimer();
    let currentValue = status.value === 'on';

    if (currentValue === value) {
      this.log('(value matches current, not updating)');
      return true;
    }

    return this.client.setShowerTimer(value).then(s => {
      this.log('...status', s.status);
      if (s.status === 'ok') {
        return this.setValue(Capabilities.SHOWER_TIMER, value);
      }
    });
  }

  // Set shower time.
  async onSetShowerTime(data, opts) {
    let value = data[Capabilities.SHOWER_TIME];
    this.log('Setting shower time to ', value, ' minutes');

    return this.client.setShowerTime(value).then(s => {
      this.log('...status',s.status);
      if (s.status === 'ok') {
        return this.setValue(Capabilities.SHOWER_TIME, value);
      }
    })
  }

  async startSyncing() {
    // Prevent more than one syncing cycle.
    if (this.hasSyncingStarted) return;

    // Start syncing.
    this.hasSyncingStarted = true;
    this.log('starting sync');
    this.sync();
  }

  async sync() {
    if (! this.shouldSync || this.isSyncing) return;

    this.isSyncing = true;
    this.log('syncing');
    try {
      await this.updateStatus();
      await this.setAvailable(); // We could update so the device is available.
    } catch(e) {
      this.log('error syncing', e);
      await this.setUnavailable(this.homey.__('device.sync_error') + ': ' + e.message);
    }
    this.isSyncing = false;

    // Schedule next sync.
    this.timeout = setTimeout(
      () => this.sync(),
      Homey.env.DEBUG ? 10000 : this.settings.syncInterval * 1000
    );
  }

  // A new device was added.
  async onAdded() {
    this.log('new device added: ', this.getName(), this.getData().serialNumber);
  }

  // A device was deleted.
  async onDeleted() {
    this.log('device deleted', this.getName(), this.settings.serialNumber);
    this.client  && this.client.end();
    this.timeout && clearTimeout(this.timeout);
    this.shouldSync = false;
    this.setUnavailable();
  }

  // Called when used changed settings, in which
  // case we need to validate some stuff.
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    // If credentials have changed, validate client.
    if (changedKeys.includes('password') || changedKeys.includes('serialNumber') || changedKeys.includes('accessKey')) {
      try {
        var client = await this.getClient(newSettings);
        await client.status();
        this.client = client;
        // in case the device was unavailable before due to invalid
        // credentials, set it to available again and make sure it's
        // also syncing.
        this.setAvailable();
        this.startSyncing();
      } catch(e) {
        this.log('unable to validate password change');
        client && client.end();
        throw Error(this.homey.__('settings.password'));
      }
    }
    this.settings = Object.assign({}, newSettings);
  }

}
