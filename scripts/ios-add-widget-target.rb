#!/usr/bin/env ruby
# Adds the GeoTimeWidget WidgetKit app-extension target to ios/App/App.xcodeproj.
#
# Idempotent: exits cleanly if the target already exists. If a run fails partway,
# restore the project first (`git checkout ios/App/App.xcodeproj/project.pbxproj`)
# and re-run.
#
# Uses the `xcodeproj` gem bundled with CocoaPods, e.g.:
#   GEM_PATH=/opt/homebrew/Cellar/cocoapods/1.16.2_2/libexec ruby scripts/ios-add-widget-target.rb

require 'xcodeproj'

PROJECT_PATH = File.expand_path('../ios/App/App.xcodeproj', __dir__)
TEAM = '3WCH54M3A8'
DEPLOYMENT = '15.0'
BUNDLE_ID = 'ca.matthewcarroll.geotime.GeoTimeWidget'

project = Xcodeproj::Project.open(PROJECT_PATH)
app = project.targets.find { |t| t.name == 'App' }
raise 'App target not found' unless app

if project.targets.any? { |t| t.name == 'GeoTimeWidget' }
  puts 'GeoTimeWidget target already exists; nothing to do.'
  exit 0
end

widget = project.new_target(:app_extension, 'GeoTimeWidget', :ios, DEPLOYMENT)

# --- Groups & sources -------------------------------------------------------
widget_group = project.main_group.find_subpath('GeoTimeWidget', true)
widget_group.set_path('GeoTimeWidget')
%w[GeoTimeWidgetBundle.swift GeoTimeWidget.swift WidgetTimelineProvider.swift].each do |f|
  widget.add_file_references([widget_group.new_reference(f)])
end
widget_group.new_reference('Info.plist')
widget_group.new_reference('GeoTimeWidget.entitlements')

# Shared logic compiled into BOTH the app and the widget.
shared_group = project.main_group.find_subpath('Shared', true)
shared_group.set_path('Shared')
%w[WidgetSharedStore.swift TimezoneDisplay.swift ZoneRowResolver.swift].each do |f|
  ref = shared_group.new_reference(f)
  app.add_file_references([ref])
  widget.add_file_references([ref])
end

# New app-target sources + entitlements live in the existing App/ group.
app_group = project.main_group.find_subpath('App', true)
app_group.set_path('App') if app_group.path.nil?
%w[MainViewController.swift WidgetBridgePlugin.swift].each do |f|
  app.add_file_references([app_group.new_reference(f)])
end
app_group.new_reference('App.entitlements')

# --- Build settings ---------------------------------------------------------
widget.build_configurations.each do |c|
  c.build_settings.merge!(
    'PRODUCT_BUNDLE_IDENTIFIER' => BUNDLE_ID,
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'INFOPLIST_FILE' => 'GeoTimeWidget/Info.plist',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'INFOPLIST_KEY_CFBundleDisplayName' => 'World Clocks',
    'CODE_SIGN_ENTITLEMENTS' => 'GeoTimeWidget/GeoTimeWidget.entitlements',
    'CODE_SIGN_STYLE' => 'Automatic',
    'DEVELOPMENT_TEAM' => TEAM,
    'SWIFT_VERSION' => '5.0',
    'IPHONEOS_DEPLOYMENT_TARGET' => DEPLOYMENT,
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'MARKETING_VERSION' => '1.0.0',
    'CURRENT_PROJECT_VERSION' => '1',
    'SKIP_INSTALL' => 'YES',
    'SWIFT_EMIT_LOC_STRINGS' => 'YES',
    'LD_RUNPATH_SEARCH_PATHS' => '$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks'
  )
end

app.build_configurations.each do |c|
  c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements'
end

# --- Embed the extension into the app + build dependency --------------------
embed = app.new_copy_files_build_phase('Embed Foundation Extensions')
embed.symbol_dst_subfolder_spec = :plug_ins
build_file = embed.add_file_reference(widget.product_reference)
build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
app.add_dependency(widget)

project.save
puts 'Added GeoTimeWidget target.'
